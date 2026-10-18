import { randomUUID } from 'node:crypto';
import { generateText } from 'ai';
import { sql } from 'drizzle-orm';
import { OWNER_ADDRESSES, frontdeskSecret } from './frontdesk.js';
import { secretMatches } from './assistant.js';
import { signOwnerToken, readOwnerToken } from './owner-documents-core.js';
import { createAppGateway, gatewayProviderOptions } from './gateway.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const bounded = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (html, status = 200) => new Response(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Legacy AI photo quote</title><style>body{font:18px system-ui;max-width:720px;margin:24px auto;padding:16px}h1{font-size:1.4em}img{max-width:100%;border-radius:8px}textarea{box-sizing:border-box;width:100%;min-height:160px;font:16px system-ui}input[type=text]{box-sizing:border-box;width:100%;padding:12px;font:18px system-ui;margin:8px 0}button{display:block;width:100%;box-sizing:border-box;padding:16px;margin:10px 0;font:18px system-ui;border-radius:8px;border:1px solid #ccc;background:#fff}pre{white-space:pre-wrap;background:#f6f6f6;padding:12px;border-radius:8px}p{overflow-wrap:anywhere}</style>${html}</html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" } });
const MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// A photo and the owner's note become a draft the owner must price. The optional
// vision description never states measurements, quantities, or prices.
export function createPhotoDescriber({ env = process.env, generate = generateText, gateway = createAppGateway(env) } = {}) {
  return async function describe({ mime, base64, note }) {
    if (!env.QUOTE_VISION_MODEL) throw new Error('No vision model is configured.');
    const result = await generate({
      model: gateway(env.QUOTE_VISION_MODEL),
      maxOutputTokens: 400,
      maxRetries: 0,
      timeout: 45000,
      providerOptions: gatewayProviderOptions(),
      instructions: 'Describe only the conditions visible in the photo for a contractor preparing a quote. Never state measurements, quantities, material specifications, prices, or a diagnosis you cannot see. If the photo is unclear, say so plainly. Return plain text under 120 words.',
      messages: [{ role: 'user', content: [{ type: 'text', text: `Owner note: ${note || '(none)'}` }, { type: 'image', image: Buffer.from(base64, 'base64'), mediaType: mime }] }],
    });
    const text = String(result.text || '').trim();
    if (!text) throw new Error('The description was empty.');
    return text;
  };
}

export function createQuotePhotoHandler({ getDb, mail, env = process.env, now = Date.now, describe = createPhotoDescriber({ env }) } = {}) {
  const db = () => getDb();
  let ready;
  const ensure = () => ready ||= (async () => {
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_quote_photos (id uuid PRIMARY KEY, filename text NOT NULL, mime text NOT NULL, photo text NOT NULL, note text NOT NULL DEFAULT '', description text NOT NULL DEFAULT '', quote text NOT NULL DEFAULT '', price_cents integer, status text NOT NULL DEFAULT 'draft', created_at timestamptz NOT NULL DEFAULT now())`));
    await db().execute(sql.raw('ALTER TABLE legacy_quote_photos ENABLE ROW LEVEL SECURITY'));
  })().catch(error => { ready = null; throw error; });
  const origin = () => new URL(env.FRONTDESK_PUBLIC_ORIGIN || 'https://legacyai.space').origin;
  const link = id => `${origin()}/api/frontdesk/quote-photo?token=${signOwnerToken({ id, scope: 'quote-photo', exp: now() + 14 * 86400000 }, env.RECEPTIONIST_SESSION_SECRET)}`;
  const getRow = async id => (await db().execute(sql`SELECT * FROM legacy_quote_photos WHERE id=${id}::uuid`)).rows[0];
  const money = cents => cents === null || cents === undefined ? 'Not priced' : `$${(Number(cents) / 100).toFixed(2)}`;
  const view = (row, tokenValue, message = '') => page(`<h1>Photo quote draft</h1>${message ? `<p><b>${esc(message)}</b></p>` : ''}
    <p><b>Owner note:</b> ${esc(row.note || '(none)')}</p>
    ${row.description ? `<p><b>Visible conditions:</b></p><pre>${esc(row.description)}</pre>` : '<p><small>No photo description was generated. Describe what you see in the quote.</small></p>'}
    <p><img alt="Job photo" src="?token=${encodeURIComponent(tokenValue)}&amp;photo=1"></p>
    <form method="post"><input type="hidden" name="token" value="${esc(tokenValue)}"><input type="hidden" name="action" value="save">
    <label>Quote text <textarea name="quote" maxlength="4000">${esc(row.quote)}</textarea></label>
    <label>Price in dollars <input type="text" name="price" value="${row.price_cents === null ? '' : (row.price_cents / 100).toFixed(2)}" placeholder="0.00"></label>
    <button>Save priced quote</button></form>
    <p>Status: <b>${esc(row.status)}</b> · ${esc(money(row.price_cents))}</p>
    <p><small>You set every price. Nothing is sent to a customer and no payment is taken.</small></p>`);

  return async request => {
    try {
      await ensure();
      const url = new URL(request.url);
      if (request.method === 'GET') {
        const access = readOwnerToken(url.searchParams.get('token'), env.RECEPTIONIST_SESSION_SECRET, now());
        if (!access || access.scope !== 'quote-photo' || !/^[a-f0-9-]{36}$/.test(access.id || '')) return page('<h1>This link is not valid</h1>', 401);
        const row = await getRow(access.id);
        if (!row) return page('<h1>Draft not found</h1>', 404);
        if (url.searchParams.get('photo') === '1') {
          try { return new Response(Buffer.from(row.photo, 'base64'), { headers: { 'Content-Type': row.mime, 'Cache-Control': 'private, max-age=60', 'X-Content-Type-Options': 'nosniff' } }); }
          catch { return page('<h1>Photo unavailable</h1>', 404); }
        }
        return view(row, url.searchParams.get('token'));
      }
      if (request.method !== 'POST') return json({ error: 'GET or POST required.' }, 405);
      if (Number(request.headers.get('content-length') || 0) > 3600000) return json({ error: 'Too large.' }, 413);
      if (request.headers.get('content-type')?.includes('application/json')) {
        if (!env.QUOTE_SECRET && !env.RECEPTIONIST_WEBHOOK_SECRET) return json({ error: 'Not authorized.' }, 401);
        if (!frontdeskSecret(request).some(value => secretMatches(value, env.QUOTE_SECRET || env.RECEPTIONIST_WEBHOOK_SECRET))) return json({ error: 'Not authorized.' }, 401);
        const raw = await request.text();
        if (Buffer.byteLength(raw) > 3600000) return json({ error: 'Too large.' }, 413);
        const input = JSON.parse(raw);
        if (input.action && input.action !== 'upload') return json({ error: 'Unknown action.' }, 400);
        const filename = bounded(input.filename, 120) || 'photo', mime = bounded(input.mime, 40), note = bounded(input.note, 2000);
        if (!MIME[mime]) return json({ error: 'Use a JPEG, PNG, or WebP photo.' }, 400);
        const base64 = String(input.data || '').replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return json({ error: 'The photo data is not valid base64.' }, 400);
        const bytes = Buffer.from(base64, 'base64').length;
        if (bytes < 100) return json({ error: 'The photo is empty.' }, 400);
        if (bytes > 2500000) return json({ error: 'The photo must be 2.5 MB or smaller.' }, 413);
        let description = '', described = false;
        try { description = bounded(await describe({ mime, base64, note }), 4000); described = Boolean(description); }
        catch (error) { try { console.info(JSON.stringify({ event: 'quote_photo_description_failed', name: error?.name || 'Error', message: String(error?.message || '').slice(0, 160) })); } catch { /* logging must not block the upload */ } }
        const id = randomUUID();
        await db().execute(sql`INSERT INTO legacy_quote_photos(id,filename,mime,photo,note,description) VALUES (${id}::uuid,${filename},${mime},${base64},${note},${description})`);
        const photoLink = link(id);
        try { await Promise.all(OWNER_ADDRESSES.map(to => mail({ to, subject: `Photo quote draft: ${filename}`, body: `A photo quote draft is ready to price.\n\nNote: ${note || '(none)'}\n${description ? `\nVisible conditions:\n${description}\n` : '\nNo description was generated.\n'}\nOpen the draft:\n${photoLink}\n\nSet every price yourself. Nothing was sent to a customer.` }))); } catch { /* the draft stands even when mail fails */ }
        return json({ ok: true, id, status: 'draft', described });
      }
      const form = await request.formData();
      const access = readOwnerToken(form.get('token'), env.RECEPTIONIST_SESSION_SECRET, now());
      if (!access || access.scope !== 'quote-photo' || !/^[a-f0-9-]{36}$/.test(access.id || '')) return page('<h1>This link is not valid</h1>', 401);
      if (form.get('action') !== 'save') return page('<h1>Unknown action</h1>', 400);
      const row = await getRow(access.id);
      if (!row) return page('<h1>Draft not found</h1>', 404);
      const quote = bounded(form.get('quote'), 4000), priceText = bounded(form.get('price'), 12);
      if (quote.length < 10) return page('<h1>Write the quote before saving</h1>', 400);
      if (!/^\d{1,7}(\.\d{1,2})?$/.test(priceText)) return page('<h1>Enter a price like 450.00</h1>', 400);
      const cents = Math.round(Number(priceText) * 100);
      await db().execute(sql`UPDATE legacy_quote_photos SET quote=${quote},price_cents=${cents},status='priced' WHERE id=${row.id}::uuid`);
      try { await Promise.all(OWNER_ADDRESSES.map(to => mail({ to, subject: `Quote priced: ${row.filename}`, body: `The photo quote is priced at ${money(cents)}.\n\n${quote}\n\nNothing was sent to a customer.` }))); } catch { /* the saving stands even when mail fails */ }
      return view({ ...row, quote, price_cents: cents, status: 'priced' }, form.get('token'), 'Quote saved.');
    } catch { return json({ error: 'The photo quote could not be completed.' }, 500); }
  };
}
