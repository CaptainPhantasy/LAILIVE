import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { OWNER_ADDRESSES, frontdeskSecret } from './frontdesk.js';
import { secretMatches } from './assistant.js';
import { signOwnerToken, readOwnerToken } from './owner-documents-core.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const bounded = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const page = (html, status = 200) => new Response(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Legacy AI review</title><style>body{font:18px system-ui;max-width:640px;margin:32px auto;padding:16px;text-align:center}button,a.button{display:block;width:100%;box-sizing:border-box;padding:16px;margin:8px 0;font:18px system-ui;border-radius:8px;border:1px solid #ccc;background:#fff}button:hover{background:#f2f2f2}textarea{box-sizing:border-box;width:100%;min-height:140px;font:16px system-ui}p{overflow-wrap:anywhere}</style>${html}</html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" } });

// The customer sees a rating page. High ratings are offered the public review link;
// low ratings go to a private note that only the owner addresses receive. Nothing is
// posted to a review platform by this code, so no publication is claimed.
export function createReviewRequestHandler({ getDb, mail, env = process.env, now = Date.now } = {}) {
  const db = () => getDb();
  let ready;
  const ensure = () => ready ||= (async () => {
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_review_requests (id uuid PRIMARY KEY, job_id text NOT NULL, customer_name text NOT NULL, customer_email text NOT NULL, status text NOT NULL, rating integer, feedback text, opened_at timestamptz, rated_at timestamptz, approved_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`));
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_review_events (id bigserial PRIMARY KEY, request_id uuid NOT NULL, event text NOT NULL, detail text, created_at timestamptz NOT NULL DEFAULT now())`));
    for (const table of ['legacy_review_requests', 'legacy_review_events']) await db().execute(sql.raw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
  })().catch(error => { ready = null; throw error; });
  const origin = () => new URL(env.FRONTDESK_PUBLIC_ORIGIN || 'https://legacyai.space').origin;
  const token = (payload, ttl) => signOwnerToken({ ...payload, exp: now() + ttl }, env.RECEPTIONIST_SESSION_SECRET);
  const approvalUrl = id => `${origin()}/api/frontdesk/review?token=${token({ id, scope: 'review-approval' }, 14 * 86400000)}`;
  const requestUrl = id => `${origin()}/api/frontdesk/review?token=${token({ id, scope: 'review-request' }, 30 * 86400000)}`;
  const getRequest = async id => (await db().execute(sql`SELECT * FROM legacy_review_requests WHERE id=${id}::uuid`)).rows[0];
  const event = async (id, name, detail = null) => { try { await db().execute(sql`INSERT INTO legacy_review_events(request_id,event,detail) VALUES (${id}::uuid,${name},${detail})`); } catch { /* a receipt must not break the customer page */ } };
  const secret = () => env.REVIEW_SECRET || env.RECEPTIONIST_WEBHOOK_SECRET;

  const ratingPage = (id, name, tokenValue) => page(`<h1>How did we do?</h1><p>${name ? `${name}, ` : ''}thank you for choosing Legacy AI. Tap the number of stars that fits your experience.</p>
    <form method="post"><input type="hidden" name="token" value="${tokenValue}"><input type="hidden" name="action" value="rate">
    ${[5, 4, 3, 2, 1].map(n => `<button name="rating" value="${n}">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</button>`).join('')}</form>
    <p><small>Your answer goes to the owner first. Nothing is posted publicly without your choice.</small></p>`);
  const thanksPage = (body) => page(`<h1>Thank you</h1>${body}`);
  const feedbackPage = (tokenValue, rating) => page(`<h1>Tell us what went wrong</h1><p>Your ${rating}-star answer was saved. Add a note for the owner so this can be fixed.</p>
    <form method="post"><input type="hidden" name="token" value="${tokenValue}"><input type="hidden" name="action" value="feedback"><textarea name="feedback" maxlength="4000" required></textarea><button>Send privately to the owner</button></form>
    <p><small>This note is not posted anywhere.</small></p>`);
  const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function rate(request, tokenValue) {
    const id = request.id;
    const rating = Number(request.form.get('rating'));
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return page('<h1>Choose a rating</h1><p><a class="button" href="?token=' + encodeURIComponent(tokenValue) + '">Go back</a></p>', 400);
    const updated = await db().execute(sql`UPDATE legacy_review_requests SET rating=${rating},rated_at=now(),status=${rating >= 4 ? 'rated' : 'needs_feedback'},updated_at=now() WHERE id=${id}::uuid AND status IN ('approved','opened') RETURNING id`);
    if (!updated.rows.length) return thanksPage('<p>This link was already answered. No change was made.</p>');
    await event(id, 'rated', String(rating));
    if (rating >= 4) {
      const publicUrl = bounded(env.GOOGLE_REVIEW_URL, 500);
      await event(id, 'public_offer', publicUrl ? 'configured' : 'not_configured');
      return thanksPage(publicUrl
        ? `<p>Thank you. If you have a moment, share it publicly:</p><p><a class="button" href="${esc(publicUrl)}" rel="noreferrer noopener">Leave a public review</a></p>`
        : '<p>Thank you. Your rating was saved for the owner.</p>');
    }
    return feedbackPage(tokenValue, rating);
  }

  async function feedback(request, tokenValue) {
    const id = request.id;
    const text = bounded(request.form.get('feedback'), 4000);
    if (text.length < 3) return feedbackPage(tokenValue, request.doc.rating || 1);
    const updated = await db().execute(sql`UPDATE legacy_review_requests SET feedback=${text},status='feedback',updated_at=now() WHERE id=${id}::uuid AND status='needs_feedback' RETURNING id`);
    if (!updated.rows.length) return thanksPage('<p>This note was already received.</p>');
    await event(id, 'feedback', String(text.length));
    try { await Promise.all(OWNER_ADDRESSES.map(to => mail({ to, subject: `Private review note from ${request.doc.customer_name}`, body: `${request.doc.customer_name} rated ${request.doc.rating}/5 for job ${request.doc.job_id}.\n\n${text}\n\nThis note is not public.` }))); } catch { /* the note is stored even when mail fails */ }
    return thanksPage('<p>Your note went straight to the owner. Nothing was posted publicly.</p>');
  }

  return async request => {
    try {
      await ensure();
      const url = new URL(request.url);
      if (request.method === 'GET') {
        const access = readOwnerToken(url.searchParams.get('token'), env.RECEPTIONIST_SESSION_SECRET, now());
        if (!access || !/^[a-f0-9-]{36}$/.test(access.id || '')) return page('<h1>This link is not valid</h1><p>Ask the owner for a new one.</p>', 401);
        const doc = await getRequest(access.id);
        if (!doc) return page('<h1>This request was not found</h1>', 404);
        if (access.scope === 'review-approval') {
          if (doc.status !== 'draft') return thanksPage(`<p>${esc(doc.customer_name)} was already ${esc(doc.status)}.</p>`);
          return page(`<h1>Send a review request?</h1><p>Customer: ${esc(doc.customer_name)} &lt;${esc(doc.customer_email)}&gt;<br>Job: ${esc(doc.job_id)}</p>
            <form method="post"><input type="hidden" name="token" value="${esc(url.searchParams.get('token'))}"><input type="hidden" name="action" value="approve"><button>Approve and email the customer</button></form>
            <p><small>Nothing is sent until you approve. The customer's rating comes back here first.</small></p>`);
        }
        if (access.scope !== 'review-request') return page('<h1>This link is not valid</h1>', 401);
        if (doc.status === 'approved') { await db().execute(sql`UPDATE legacy_review_requests SET status='opened',opened_at=now(),updated_at=now() WHERE id=${doc.id}::uuid AND status='approved'`); await event(doc.id, 'opened'); }
        if (['rated', 'feedback'].includes(doc.status)) return thanksPage('<p>This review was already answered. Thank you.</p>');
        if (doc.status === 'needs_feedback') return feedbackPage(url.searchParams.get('token'), doc.rating || 1);
        if (!['approved', 'opened'].includes(doc.status)) return page('<h1>This link is not active</h1>', 409);
        return ratingPage(doc.id, doc.customer_name, url.searchParams.get('token'));
      }
      if (request.method !== 'POST') return json({ error: 'GET or POST required.' }, 405);
      if (Number(request.headers.get('content-length') || 0) > 8000) return json({ error: 'Too large.' }, 413);
      if (request.headers.get('content-type')?.includes('application/json')) {
        if (!secret() || !frontdeskSecret(request).some(value => secretMatches(value, secret()))) return json({ error: 'Not authorized.' }, 401);
        const raw = await request.text();
        if (Buffer.byteLength(raw) > 8000) return json({ error: 'Too large.' }, 413);
        const input = JSON.parse(raw);
        const customerName = bounded(input.customer_name, 120), customerEmail = bounded(input.customer_email, 254).toLowerCase(), jobId = bounded(input.job_id, 120);
        if (!customerName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail) || !jobId) return json({ error: 'A customer name, email and job id are required.' }, 400);
        const id = randomUUID();
        await db().execute(sql`INSERT INTO legacy_review_requests(id,job_id,customer_name,customer_email,status) VALUES (${id}::uuid,${jobId},${customerName},${customerEmail},'draft')`);
        await event(id, 'created');
        const link = approvalUrl(id);
        await Promise.all(OWNER_ADDRESSES.map(to => mail({ to, subject: `Review request for ${customerName}`, body: `A review request is ready to approve.\n\nCustomer: ${customerName} <${customerEmail}>\nJob: ${jobId}\n\nApprove and send:\n${link}\n\nNothing has been sent to the customer.` })));
        return json({ ok: true, id, status: 'draft' });
      }
      const form = await request.formData();
      const access = readOwnerToken(form.get('token'), env.RECEPTIONIST_SESSION_SECRET, now());
      if (!access || !/^[a-f0-9-]{36}$/.test(access.id || '')) return page('<h1>This link is not valid</h1>', 401);
      const doc = await getRequest(access.id);
      if (!doc) return page('<h1>This request was not found</h1>', 404);
      if (form.get('action') === 'approve') {
        if (access.scope !== 'review-approval' || doc.status !== 'draft') return thanksPage('<p>This request was already approved or is not editable.</p>');
        const claimed = await db().execute(sql`UPDATE legacy_review_requests SET status='approved',approved_at=now(),updated_at=now() WHERE id=${doc.id}::uuid AND status='draft' RETURNING id`);
        if (!claimed.rows.length) return thanksPage('<p>This request was already approved.</p>');
        await event(doc.id, 'approved');
        try { await mail({ to: doc.customer_email, subject: `How did we do, ${doc.customer_name}?`, body: `${doc.customer_name}, thank you for choosing Legacy AI.\n\nOne tap tells us how the visit went:\n${requestUrl(doc.id)}\n\nYour answer goes to the owner first. Nothing is posted publicly without your choice.` }); }
        catch { return page('<h1>Approved, but the email failed</h1><p>The request is marked approved. Check the mail provider before retrying; no customer email is confirmed.</p>', 502); }
        await event(doc.id, 'sent');
        return thanksPage(`<p>Approved. The review request was emailed to ${esc(doc.customer_email)}.</p>`);
      }
      if (access.scope !== 'review-request') return page('<h1>This link is not valid</h1>', 401);
      const action = form.get('action');
      if (action === 'rate') return rate({ ...access, form, doc }, form.get('token'));
      if (action === 'feedback') return feedback({ ...access, form, doc }, form.get('token'));
      return page('<h1>Unknown action</h1>', 400);
    } catch { return json({ error: 'The review request could not be completed.' }, 500); }
  };
}
