import { randomUUID } from 'node:crypto';
import { generateText } from 'ai';
import { sql } from 'drizzle-orm';
import { OWNER_ADDRESSES, frontdeskSecret } from './frontdesk.js';
import { secretMatches } from './assistant.js';
import { signOwnerToken, readOwnerToken } from './owner-documents-core.js';
import { createAppGateway, gatewayProviderOptions } from './gateway.js';
import { BOARD_DEEPSEEK_MODEL } from './board-policy.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const bounded = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (html, status = 200) => new Response(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Legacy AI review reply</title><style>body{font:18px system-ui;max-width:760px;margin:32px auto;padding:16px}h1{font-size:1.4em}textarea{box-sizing:border-box;width:100%;min-height:180px;font:16px system-ui}button,a.button{display:inline-block;padding:12px 16px;margin:8px 8px 8px 0;font:16px system-ui}pre{white-space:pre-wrap;background:#f6f6f6;padding:12px;border-radius:8px}p{overflow-wrap:anywhere}</style>${html}</html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" } });

// A reply is drafted for the owner to edit and approve. Nothing is posted to a
// review platform and no customer email is sent by this code.
export function createReviewResponder({ env = process.env, generate = generateText, gateway = createAppGateway(env) } = {}) {
  return async function draftReply({ reviewer, rating, review }) {
    if (!env.VERCEL && !env.AI_GATEWAY_API_KEY && !env.VERCEL_OIDC_TOKEN) throw new Error('The assistant is not connected.');
    const configured = env.REVIEW_MODEL || BOARD_DEEPSEEK_MODEL;
    const result = await generate({
      model: gateway(configured),
      maxOutputTokens: 400,
      maxRetries: 0,
      timeout: 45000,
      providerOptions: gatewayProviderOptions({ gateway: String(configured).startsWith('deepseek/') ? { only: ['deepseek'] } : {} }),
      instructions: 'You write short, human replies to customer reviews for Legacy AI, a home-services AI company run by Douglas. Reply in the language of the review. Thank the reviewer specifically, address only what the review says, never invent facts, never promise a refund, discount, or timeline that was not supplied, never ask for personal or payment details in the reply, and keep it under 120 words. Sign "Douglas, Legacy AI". Return only the reply text.',
      prompt: `Rating: ${rating}/5\nReviewer: ${reviewer || 'Customer'}\nReview: ${review}`,
    });
    const text = String(result.text || '').trim();
    if (!text) throw new Error('The reply was empty.');
    return text;
  };
}

export function createReviewResponseHandler({ getDb, mail, env = process.env, now = Date.now, generateResponse = createReviewResponder({ env }) } = {}) {
  const db = () => getDb();
  let ready;
  const ensure = () => ready ||= (async () => {
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_review_responses (id uuid PRIMARY KEY, reviewer text NOT NULL, rating integer NOT NULL, review text NOT NULL, reply text NOT NULL, status text NOT NULL, version integer NOT NULL DEFAULT 1, approved_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`));
    await db().execute(sql.raw('ALTER TABLE legacy_review_responses ENABLE ROW LEVEL SECURITY'));
  })().catch(error => { ready = null; throw error; });
  const origin = () => new URL(env.FRONTDESK_PUBLIC_ORIGIN || 'https://legacyai.space').origin;
  const link = id => `${origin()}/api/frontdesk/review-response?token=${signOwnerToken({ id, scope: 'review-response', exp: now() + 14 * 86400000 }, env.RECEPTIONIST_SESSION_SECRET)}`;
  const getRow = async id => (await db().execute(sql`SELECT * FROM legacy_review_responses WHERE id=${id}::uuid`)).rows[0];
  const editor = (row, tokenValue) => page(`<h1>Reply to ${esc(row.reviewer || 'customer')} · ${row.rating}/5</h1>
    <p><b>Review:</b> ${esc(row.review)}</p>
    <form method="post"><input type="hidden" name="token" value="${esc(tokenValue)}"><input type="hidden" name="version" value="${row.version}">
    <label>Reply <textarea name="reply" maxlength="4000">${esc(row.reply)}</textarea></label>
    <button name="action" value="save">Save draft</button><button name="action" value="approve">Approve reply</button></form>
    <p><small>Approving stores the final text and emails it to the owner addresses. Nothing is posted to a review site and no customer email is sent.</small></p>`);
  const approved = row => page(`<h1>Approved reply · ${row.rating}/5</h1><p>Copy this into the review site:</p><pre>${esc(row.reply)}</pre>
    <p><small>Approved ${esc(String(row.approved_at || ''))}. Nothing was posted by Legacy AI.</small></p>`);

  return async request => {
    try {
      await ensure();
      const url = new URL(request.url);
      if (request.method === 'GET') {
        const access = readOwnerToken(url.searchParams.get('token'), env.RECEPTIONIST_SESSION_SECRET, now());
        if (!access || access.scope !== 'review-response' || !/^[a-f0-9-]{36}$/.test(access.id || '')) return page('<h1>This link is not valid</h1>', 401);
        const row = await getRow(access.id);
        if (!row) return page('<h1>Reply not found</h1>', 404);
        return row.status === 'approved' ? approved(row) : editor(row, url.searchParams.get('token'));
      }
      if (request.method !== 'POST') return json({ error: 'GET or POST required.' }, 405);
      if (Number(request.headers.get('content-length') || 0) > 16000) return json({ error: 'Too large.' }, 413);
      if (request.headers.get('content-type')?.includes('application/json')) {
        if (!env.REVIEW_SECRET && !env.RECEPTIONIST_WEBHOOK_SECRET) return json({ error: 'Not authorized.' }, 401);
        if (!frontdeskSecret(request).some(value => secretMatches(value, env.REVIEW_SECRET || env.RECEPTIONIST_WEBHOOK_SECRET))) return json({ error: 'Not authorized.' }, 401);
        const raw = await request.text();
        if (Buffer.byteLength(raw) > 16000) return json({ error: 'Too large.' }, 413);
        const input = JSON.parse(raw);
        const reviewer = bounded(input.reviewer, 120), review = bounded(input.review, 4000), rating = Number(input.rating);
        if (review.length < 3 || !Number.isInteger(rating) || rating < 1 || rating > 5) return json({ error: 'A review and a rating from 1 to 5 are required.' }, 400);
        let reply = '', generated = true;
        try { reply = bounded(await generateResponse({ reviewer, rating, review }), 4000); }
        catch (error) { generated = false; try { console.info(JSON.stringify({ event: 'review_reply_generation_failed', name: error?.name || 'Error', message: String(error?.message || '').slice(0, 160) })); } catch { /* logging must not block the draft */ } }
        const id = randomUUID();
        await db().execute(sql`INSERT INTO legacy_review_responses(id,reviewer,rating,review,reply,status) VALUES (${id}::uuid,${reviewer},${rating},${review},${reply},'draft')`);
        const reviewLink = link(id);
        try {
          await Promise.all(OWNER_ADDRESSES.map(to => mail({ to, subject: `Review reply draft for ${reviewer || 'a customer'}`, body: `A ${rating}/5 review needs a reply.\n\n${review}\n\n${reply ? `Draft reply:\n${reply}` : 'No draft was generated; write the reply on the review page.'}\n\nEdit and approve:\n${reviewLink}\n\nNothing is posted to a review site.` })));
        } catch { /* the draft is stored even when the owner mail fails */ }
        return json({ ok: true, id, status: 'draft', generated });
      }
      const form = await request.formData();
      const access = readOwnerToken(form.get('token'), env.RECEPTIONIST_SESSION_SECRET, now());
      if (!access || access.scope !== 'review-response' || !/^[a-f0-9-]{36}$/.test(access.id || '')) return page('<h1>This link is not valid</h1>', 401);
      const row = await getRow(access.id);
      if (!row) return page('<h1>Reply not found</h1>', 404);
      if (row.status !== 'draft') return approved(row);
      const version = Number(form.get('version'));
      if (!Number.isSafeInteger(version) || version !== row.version) return page('<h1>This page is out of date</h1><p>Reload the link and try again.</p>', 409);
      const reply = bounded(form.get('reply'), 4000);
      if (form.get('action') === 'save') {
        if (reply.length < 3) return page('<h1>A reply is required</h1>', 400);
        const saved = await db().execute(sql`UPDATE legacy_review_responses SET reply=${reply},version=version+1,updated_at=now() WHERE id=${row.id}::uuid AND status='draft' AND version=${version} RETURNING id`);
        if (!saved.rows.length) return page('<h1>This page is out of date</h1><p>Another tab saved first. Reload the link and try again.</p>', 409);
        return page(`<h1>Saved</h1><p><a class="button" href="?token=${encodeURIComponent(form.get('token'))}">Back to the reply</a></p>`);
      }
      if (form.get('action') === 'approve') {
        if (reply.length < 3) return page('<h1>A reply is required before approving</h1>', 400);
        const claimed = await db().execute(sql`UPDATE legacy_review_responses SET reply=${reply},status='approved',approved_at=now(),version=version+1,updated_at=now() WHERE id=${row.id}::uuid AND status='draft' AND version=${version} RETURNING id`);
        if (!claimed.rows.length) return page('<h1>Already handled</h1><p>This reply was approved or changed elsewhere.</p>', 409);
        try { await Promise.all(OWNER_ADDRESSES.map(to => mail({ to, subject: `Approved reply ready to paste · ${row.reviewer || 'customer'}`, body: `The reply for the ${row.rating}/5 review is approved.\n\n${reply}\n\nCopy it into the review site. Nothing was posted by Legacy AI.` }))); } catch { /* the approval is stored even when mail fails */ }
        return approved({ ...row, reply, approved_at: new Date(now()).toISOString() });
      }
      return page('<h1>Unknown action</h1>', 400);
    } catch { return json({ error: 'The review reply could not be completed.' }, 500); }
  };
}
