import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { OWNER_ADDRESSES, frontdeskSecret } from './frontdesk.js';
import { secretMatches } from './assistant.js';
import { signOwnerToken, readOwnerToken } from './owner-documents-core.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const bounded = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = cents => `$${(Number(cents) / 100).toFixed(2)}`;
const page = (html, status = 200) => new Response(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Legacy AI add-on offer</title><style>body{font:18px system-ui;max-width:640px;margin:24px auto;padding:16px}h1{font-size:1.4em}button{display:block;width:100%;box-sizing:border-box;padding:16px;margin:10px 0;font:18px system-ui;border-radius:8px;border:1px solid #ccc;background:#fff}button:hover{background:#f2f2f2}pre{white-space:pre-wrap;background:#f6f6f6;padding:12px;border-radius:8px}p{overflow-wrap:anywhere}</style>${html}</html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" } });

// A job-specific add-on the owner can offer. The owner approves or declines it;
// nothing is sent to the customer and no price is invented.
export function createUpsellHandler({ getDb, mail, env = process.env, now = Date.now } = {}) {
  const db = () => getDb();
  let ready;
  const ensure = () => ready ||= (async () => {
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_upsell_offers (id uuid PRIMARY KEY, job uuid NOT NULL, name text NOT NULL, price_cents integer NOT NULL, note text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'draft', approved_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`));
    await db().execute(sql.raw('ALTER TABLE legacy_upsell_offers ENABLE ROW LEVEL SECURITY'));
  })().catch(error => { ready = null; throw error; });
  const origin = () => new URL(env.FRONTDESK_PUBLIC_ORIGIN || 'https://legacyai.space').origin;
  const link = id => `${origin()}/api/frontdesk/upsells?token=${signOwnerToken({ id, scope: 'upsell', exp: now() + 14 * 86400000 }, env.RECEPTIONIST_SESSION_SECRET)}`;
  const getOffer = async id => (await db().execute(sql`SELECT * FROM legacy_upsell_offers WHERE id=${id}::uuid`)).rows[0];
  const getJob = async id => (await db().execute(sql`SELECT * FROM legacy_jobs WHERE id=${id}::uuid`)).rows[0];
  const script = (offer, job) => `While we are at ${job.address || 'the property'}, would you like us to add ${offer.name} for ${money(offer.price_cents)}?`;
  const view = (offer, job, tokenValue, message = '') => page(`<h1>${esc(offer.name)} · ${money(offer.price_cents)}</h1>${message ? `<p><b>${esc(message)}</b></p>` : ''}
    <p>${esc(job.customer_name)} · job ${esc(job.job_id)}<br>${esc(job.service || 'service not supplied')}<br>${esc(job.address || '')}</p>
    ${offer.note ? `<p><b>Owner note:</b> ${esc(offer.note)}</p>` : ''}
    <p>Offer script (read or text to the customer yourself):</p><pre>${esc(script(offer, job))}</pre>
    <p>Status: <b>${esc(offer.status)}</b></p>
    ${offer.status === 'draft' ? `<form method="post"><input type="hidden" name="token" value="${esc(tokenValue)}">
      <button name="action" value="approve">Approve this add-on</button><button name="action" value="decline">Decline</button></form>` : ''}
    <p><small>Approving marks the add-on ready for you to offer. Nothing is sent to the customer and no price is invented.</small></p>`);

  return async request => {
    try {
      await ensure();
      const url = new URL(request.url);
      if (request.method === 'GET') {
        const access = readOwnerToken(url.searchParams.get('token'), env.RECEPTIONIST_SESSION_SECRET, now());
        if (!access || access.scope !== 'upsell' || !/^[a-f0-9-]{36}$/.test(access.id || '')) return page('<h1>This link is not valid</h1>', 401);
        const offer = await getOffer(access.id);
        if (!offer) return page('<h1>Offer not found</h1>', 404);
        return view(offer, await getJob(offer.job), url.searchParams.get('token'));
      }
      if (request.method !== 'POST') return json({ error: 'GET or POST required.' }, 405);
      if (Number(request.headers.get('content-length') || 0) > 8000) return json({ error: 'Too large.' }, 413);
      if (request.headers.get('content-type')?.includes('application/json')) {
        if (!env.UPSELL_SECRET && !env.RECEPTIONIST_WEBHOOK_SECRET) return json({ error: 'Not authorized.' }, 401);
        if (!frontdeskSecret(request).some(value => secretMatches(value, env.UPSELL_SECRET || env.RECEPTIONIST_WEBHOOK_SECRET))) return json({ error: 'Not authorized.' }, 401);
        const raw = await request.text();
        if (Buffer.byteLength(raw) > 8000) return json({ error: 'Too large.' }, 413);
        const input = JSON.parse(raw);
        if (input.action && input.action !== 'add') return json({ error: 'Unknown action.' }, 400);
        const jobId = bounded(input.job_id, 64), name = bounded(input.name, 120), note = bounded(input.note, 500), price = Number(input.price_cents);
        if (!name || !Number.isSafeInteger(price) || price <= 0 || price > 10000000) return json({ error: 'A name and a positive price in cents are required.' }, 400);
        const job = (await db().execute(sql`SELECT * FROM legacy_jobs WHERE job_id=${jobId}`)).rows[0];
        if (!job) return json({ error: 'No job matches that job id.' }, 400);
        const id = randomUUID();
        await db().execute(sql`INSERT INTO legacy_upsell_offers(id,job,name,price_cents,note) VALUES (${id}::uuid,${job.id}::uuid,${name},${price},${note})`);
        const offerLink = link(id);
        try { await Promise.all(OWNER_ADDRESSES.map(to => mail({ to, subject: `Add-on offer for ${job.customer_name}: ${name}`, body: `A job-specific add-on is ready to approve.\n\nJob ${job.job_id} — ${job.customer_name}\n${name} — ${money(price)}\n${note ? `Note: ${note}\n` : ''}\nApprove or decline:\n${offerLink}\n\nNothing was sent to the customer.` }))); } catch { /* the offer stands even when mail fails */ }
        return json({ ok: true, id, status: 'draft', job_id: job.job_id, name, price_cents: price });
      }
      const form = await request.formData();
      const access = readOwnerToken(form.get('token'), env.RECEPTIONIST_SESSION_SECRET, now());
      if (!access || access.scope !== 'upsell' || !/^[a-f0-9-]{36}$/.test(access.id || '')) return page('<h1>This link is not valid</h1>', 401);
      const offer = await getOffer(access.id);
      if (!offer) return page('<h1>Offer not found</h1>', 404);
      const action = form.get('action');
      if (!['approve', 'decline'].includes(action)) return page('<h1>Unknown action</h1>', 400);
      if (offer.status !== 'draft') return view(offer, await getJob(offer.job), form.get('token'), 'This offer was already handled.');
      const status = action === 'approve' ? 'approved' : 'declined';
      const claimed = await db().execute(sql`UPDATE legacy_upsell_offers SET status=${status},approved_at=${status === 'approved' ? sql`now()` : sql`NULL`} WHERE id=${offer.id}::uuid AND status='draft' RETURNING id`);
      if (!claimed.rows.length) return view(await getOffer(offer.id), await getJob(offer.job), form.get('token'), 'This offer was already handled.');
      try { await Promise.all(OWNER_ADDRESSES.map(to => mail({ to, subject: `${status === 'approved' ? 'Approved' : 'Declined'} add-on: ${offer.name}`, body: `The add-on for job ${offer.id} was ${status}.\n\n${offer.name} — ${money(offer.price_cents)}\n\nNothing was sent to the customer.` }))); } catch { /* the decision stands even when mail fails */ }
      return view({ ...offer, status }, await getJob(offer.job), form.get('token'), status === 'approved' ? 'Approved. Offer it when you are ready.' : 'Declined.');
    } catch { return json({ error: 'The add-on offer could not be completed.' }, 500); }
  };
}
