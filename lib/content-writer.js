import { randomUUID } from 'node:crypto';
import { generateText } from 'ai';
import { sql } from 'drizzle-orm';
import { OWNER_ADDRESSES, frontdeskSecret } from './frontdesk.js';
import { secretMatches } from './assistant.js';
import { signOwnerToken, readOwnerToken } from './owner-documents-core.js';
import { createAppGateway, gatewayProviderOptions } from './gateway.js';
import { BOARD_DEEPSEEK_MODEL } from './board-policy.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const bounded = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CHANNELS = ['blog', 'email', 'social'];
const page = (html, status = 200) => new Response(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Legacy AI content draft</title><style>body{font:18px system-ui;max-width:720px;margin:24px auto;padding:16px}h1{font-size:1.4em}textarea{box-sizing:border-box;width:100%;min-height:260px;font:16px system-ui}button{display:block;width:100%;box-sizing:border-box;padding:16px;margin:10px 0;font:18px system-ui;border-radius:8px;border:1px solid #ccc;background:#fff}p{overflow-wrap:anywhere}</style>${html}</html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" } });

// A scheduled topic becomes a draft the owner edits and approves. Nothing is
// published and no statistic, price, or guarantee is invented.
export function createContentDrafter({ env = process.env, generate = generateText, gateway = createAppGateway(env) } = {}) {
  return async function draft({ topic, channel, angle }) {
    if (!env.VERCEL && !env.AI_GATEWAY_API_KEY && !env.VERCEL_OIDC_TOKEN) throw new Error('The writer is not connected.');
    const configured = env.CONTENT_MODEL || BOARD_DEEPSEEK_MODEL;
    const limits = channel === 'blog' ? '450' : channel === 'email' ? '180' : '80';
    const result = await generate({
      model: gateway(configured),
      maxOutputTokens: 900,
      maxRetries: 0,
      timeout: 60000,
      providerOptions: gatewayProviderOptions({ gateway: String(configured).startsWith('deepseek/') ? { only: ['deepseek'] } : {} }),
      instructions: `Write a ${channel} draft for Legacy AI, a home-services AI company run by Douglas in Indiana. Plain, concrete language a contractor would actually read. Never invent statistics, customer names, prices, guarantees, or results. No emoji. End by inviting a reply or a call to action where it fits. Return only the draft, under ${limits} words.`,
      prompt: `Topic: ${topic}${angle ? `\nAngle: ${angle}` : ''}`,
    });
    const text = String(result.text || '').trim();
    if (!text) throw new Error('The draft was empty.');
    return text;
  };
}

export function createContentWriter({ getDb, mail, env = process.env, now = Date.now, draft = createContentDrafter({ env }) } = {}) {
  const db = () => getDb();
  let ready;
  const ensure = () => ready ||= (async () => {
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_content_drafts (id uuid PRIMARY KEY, topic text NOT NULL, channel text NOT NULL, angle text NOT NULL DEFAULT '', draft text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'draft', version integer NOT NULL DEFAULT 1, decided_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`));
    await db().execute(sql.raw('ALTER TABLE legacy_content_drafts ENABLE ROW LEVEL SECURITY'));
  })().catch(error => { ready = null; throw error; });
  const origin = () => new URL(env.FRONTDESK_PUBLIC_ORIGIN || 'https://legacyai.space').origin;
  const link = id => `${origin()}/api/frontdesk/content?token=${signOwnerToken({ id, scope: 'content', exp: now() + 14 * 86400000 }, env.RECEPTIONIST_SESSION_SECRET)}`;
  const getRow = async id => (await db().execute(sql`SELECT * FROM legacy_content_drafts WHERE id=${id}::uuid`)).rows[0];
  const view = (row, tokenValue, message = '') => page(`<h1>${esc(row.topic)}</h1>${message ? `<p><b>${esc(message)}</b></p>` : ''}
    <p>Channel: <b>${esc(row.channel)}</b> · Status: <b>${esc(row.status)}</b>${row.angle ? ` · Angle: ${esc(row.angle)}` : ''}</p>
    ${row.status === 'draft' ? `<form method="post"><input type="hidden" name="token" value="${esc(tokenValue)}"><input type="hidden" name="version" value="${row.version}">
      <textarea name="draft" maxlength="8000">${esc(row.draft)}</textarea>
      <button name="action" value="save">Save draft</button>
      <button name="action" value="approve">Approve for use</button>
      <button name="action" value="reject">Reject</button></form>` : `<pre>${esc(row.draft)}</pre><p><small>This draft is ${esc(row.status)}. Nothing was published.</small></p>`}
    <p><small>Approve only after you have read it. Nothing is posted to a blog, email platform, or social account by this page.</small></p>`);

  return async request => {
    try {
      await ensure();
      const url = new URL(request.url);
      if (request.method === 'GET') {
        const access = readOwnerToken(url.searchParams.get('token'), env.RECEPTIONIST_SESSION_SECRET, now());
        if (!access || access.scope !== 'content' || !/^[a-f0-9-]{36}$/.test(access.id || '')) return page('<h1>This link is not valid</h1>', 401);
        const row = await getRow(access.id);
        if (!row) return page('<h1>Draft not found</h1>', 404);
        return view(row, url.searchParams.get('token'));
      }
      if (request.method !== 'POST') return json({ error: 'GET or POST required.' }, 405);
      if (Number(request.headers.get('content-length') || 0) > 20000) return json({ error: 'Too large.' }, 413);
      if (request.headers.get('content-type')?.includes('application/json')) {
        if (!env.CONTENT_SECRET && !env.RECEPTIONIST_WEBHOOK_SECRET) return json({ error: 'Not authorized.' }, 401);
        if (!frontdeskSecret(request).some(value => secretMatches(value, env.CONTENT_SECRET || env.RECEPTIONIST_WEBHOOK_SECRET))) return json({ error: 'Not authorized.' }, 401);
        const raw = await request.text();
        if (Buffer.byteLength(raw) > 20000) return json({ error: 'Too large.' }, 413);
        const input = JSON.parse(raw);
        if (input.action && input.action !== 'add') return json({ error: 'Unknown action.' }, 400);
        const topic = bounded(input.topic, 200), channel = bounded(input.channel, 20) || 'blog', angle = bounded(input.angle, 300);
        if (!topic) return json({ error: 'A topic is required.' }, 400);
        if (!CHANNELS.includes(channel)) return json({ error: 'Channel must be blog, email, or social.' }, 400);
        let body = '', generated = true;
        try { body = bounded(await draft({ topic, channel, angle }), 8000); }
        catch (error) { generated = false; try { console.info(JSON.stringify({ event: 'content_draft_failed', name: error?.name || 'Error', message: String(error?.message || '').slice(0, 160) })); } catch { /* logging must not block the draft */ } }
        const id = randomUUID();
        await db().execute(sql`INSERT INTO legacy_content_drafts(id,topic,channel,angle,draft) VALUES (${id}::uuid,${topic},${channel},${angle},${body})`);
        const draftLink = link(id);
        try { await Promise.all(OWNER_ADDRESSES.map(to => mail({ to, subject: `Content draft: ${topic}`, body: `A ${channel} draft is ready for review.\n\n${body || 'No draft was generated; write it on the review page.'}\n\nEdit and approve:\n${draftLink}\n\nNothing was published.` }))); } catch { /* the draft stands even when mail fails */ }
        return json({ ok: true, id, channel, status: 'draft', generated });
      }
      const form = await request.formData();
      const access = readOwnerToken(form.get('token'), env.RECEPTIONIST_SESSION_SECRET, now());
      if (!access || access.scope !== 'content' || !/^[a-f0-9-]{36}$/.test(access.id || '')) return page('<h1>This link is not valid</h1>', 401);
      const row = await getRow(access.id);
      if (!row) return page('<h1>Draft not found</h1>', 404);
      if (row.status !== 'draft') return view(row, form.get('token'), 'This draft was already decided.');
      const version = Number(form.get('version'));
      if (!Number.isSafeInteger(version) || version !== row.version) return page('<h1>This page is out of date</h1><p>Reload the link and try again.</p>', 409);
      const action = form.get('action');
      const text = bounded(form.get('draft'), 8000);
      if (action === 'save') {
        if (text.length < 20) return page('<h1>Write at least a short draft</h1>', 400);
        const updated = await db().execute(sql`UPDATE legacy_content_drafts SET draft=${text},version=version+1 WHERE id=${row.id}::uuid AND status='draft' AND version=${version} RETURNING version`);
        if (!updated.rows.length) return page('<h1>This page is out of date</h1>', 409);
        return view({ ...row, draft: text, version: version + 1 }, form.get('token'), 'Draft saved.');
      }
      if (!['approve', 'reject'].includes(action)) return page('<h1>Unknown action</h1>', 400);
      if (action === 'approve' && text.length < 20) return page('<h1>Approve only a complete draft</h1>', 400);
      const status = action === 'approve' ? 'approved' : 'rejected';
      const claimed = await db().execute(sql`UPDATE legacy_content_drafts SET draft=${text || row.draft},status=${status},decided_at=now(),version=version+1 WHERE id=${row.id}::uuid AND status='draft' AND version=${version} RETURNING id`);
      if (!claimed.rows.length) return page('<h1>Already decided</h1>', 409);
      try { await Promise.all(OWNER_ADDRESSES.map(to => mail({ to, subject: `Content ${status}: ${row.topic}`, body: `The ${row.channel} draft was ${status}.\n\n${text || row.draft}\n\nCopy it wherever you want it. Nothing was published by Legacy AI.` }))); } catch { /* the decision stands */ }
      return view({ ...row, draft: text || row.draft, status }, form.get('token'), action === 'approve' ? 'Approved. Copy it where you want it.' : 'Rejected.');
    } catch { return json({ error: 'The content action could not be completed.' }, 500); }
  };
}
