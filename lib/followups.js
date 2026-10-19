import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { OWNER_ADDRESSES, frontdeskSecret } from './frontdesk.js';
import { secretMatches } from './assistant.js';
import { signOwnerToken, readOwnerToken } from './owner-documents-core.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const bounded = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (html, status = 200) => new Response(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Legacy AI follow-ups</title><style>body{font:18px system-ui;max-width:760px;margin:24px auto;padding:16px}h1{font-size:1.4em}li{margin:16px 0}button{display:inline-block;padding:10px 14px;margin:6px 8px 6px 0;font:16px system-ui;border-radius:8px;border:1px solid #ccc;background:#fff}pre{white-space:pre-wrap;background:#f6f6f6;padding:10px;border-radius:8px}p{overflow-wrap:anywhere}</style>${html}</html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" } });

// Each follow-up step is written by the owner and approved before it can send.
// The sender only picks up approved steps whose due time has arrived.
export function createFollowupHandler({ getDb, mail, env = process.env, now = Date.now } = {}) {
  const db = () => getDb();
  let ready;
  const ensure = () => ready ||= (async () => {
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_followup_steps (id uuid PRIMARY KEY, inquiry_id uuid NOT NULL, step integer NOT NULL, subject text NOT NULL, body text NOT NULL, status text NOT NULL DEFAULT 'draft', due_at timestamptz NOT NULL, approved_at timestamptz, sent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`));
    await db().execute(sql.raw('ALTER TABLE legacy_followup_steps ENABLE ROW LEVEL SECURITY'));
  })().catch(error => { ready = null; throw error; });
  const origin = () => new URL(env.FRONTDESK_PUBLIC_ORIGIN || 'https://legacyai.space').origin;
  const link = inquiryId => `${origin()}/api/frontdesk/followups?token=${signOwnerToken({ id: inquiryId, scope: 'followups', exp: now() + 14 * 86400000 }, env.RECEPTIONIST_SESSION_SECRET)}`;
  const getInquiry = async id => (await db().execute(sql`SELECT i.id, c.name, c.email FROM legacy_inquiries i JOIN legacy_contacts c ON c.id=i.contact_id WHERE i.id=${id}::uuid`)).rows[0];
  const stepsFor = async id => (await db().execute(sql`SELECT * FROM legacy_followup_steps WHERE inquiry_id=${id}::uuid ORDER BY step`)).rows;

  async function due() {
    const rows = (await db().execute(sql`SELECT s.*, c.name, c.email FROM legacy_followup_steps s JOIN legacy_inquiries i ON i.id=s.inquiry_id JOIN legacy_contacts c ON c.id=i.contact_id WHERE s.status='approved' AND s.due_at <= now() ORDER BY s.due_at LIMIT 25`)).rows;
    let sent = 0, failed = 0;
    for (const row of rows) {
      const claimed = await db().execute(sql`UPDATE legacy_followup_steps SET status='sending' WHERE id=${row.id}::uuid AND status='approved' RETURNING id`);
      if (!claimed.rows.length) continue;
      try {
        await mail({ to: row.email, subject: row.subject, body: row.body });
        await db().execute(sql`UPDATE legacy_followup_steps SET status='sent',sent_at=now() WHERE id=${row.id}::uuid`);
        sent++;
      } catch {
        await db().execute(sql`UPDATE legacy_followup_steps SET status='failed' WHERE id=${row.id}::uuid`);
        failed++;
      }
    }
    return { sent, failed, considered: rows.length };
  }

  const view = (inquiry, steps, tokenValue, message = '') => page(`<h1>Follow-ups for ${esc(inquiry.name)}</h1>${message ? `<p><b>${esc(message)}</b></p>` : ''}
    <p>${esc(inquiry.email)}</p>
    ${steps.length ? `<ol>${steps.map(step => `<li><b>Step ${step.step}</b> · ${esc(step.status)} · due ${esc(new Date(step.due_at).toISOString())}
      <pre>${esc(step.subject)}\n\n${esc(step.body)}</pre>
      ${step.status === 'draft' ? `<form method="post"><input type="hidden" name="token" value="${esc(tokenValue)}"><input type="hidden" name="step" value="${esc(step.id)}"><button name="action" value="approve">Approve</button><button name="action" value="cancel">Cancel</button></form>` : ''}
      ${step.status === 'approved' ? `<form method="post"><input type="hidden" name="token" value="${esc(tokenValue)}"><input type="hidden" name="step" value="${esc(step.id)}"><button name="action" value="cancel">Cancel</button></form>` : ''}</li>`).join('')}</ol>` : '<p>No steps yet.</p>'}
    <p><small>Only approved steps send, and only when they are due. Every step is written by the owner.</small></p>`);

  return async request => {
    try {
      await ensure();
      const url = new URL(request.url);
      if (request.method === 'GET') {
        const access = readOwnerToken(url.searchParams.get('token'), env.RECEPTIONIST_SESSION_SECRET, now());
        if (!access || access.scope !== 'followups' || !/^[a-f0-9-]{36}$/.test(access.id || '')) return page('<h1>This link is not valid</h1>', 401);
        const inquiry = await getInquiry(access.id);
        if (!inquiry) return page('<h1>Inquiry not found</h1>', 404);
        return view(inquiry, await stepsFor(access.id), url.searchParams.get('token'));
      }
      if (request.method !== 'POST') return json({ error: 'GET or POST required.' }, 405);
      if (Number(request.headers.get('content-length') || 0) > 30000) return json({ error: 'Too large.' }, 413);
      if (request.headers.get('content-type')?.includes('application/json')) {
        if (!env.FOLLOWUP_SECRET && !env.RECEPTIONIST_WEBHOOK_SECRET) return json({ error: 'Not authorized.' }, 401);
        if (!frontdeskSecret(request).some(value => secretMatches(value, env.FOLLOWUP_SECRET || env.RECEPTIONIST_WEBHOOK_SECRET))) return json({ error: 'Not authorized.' }, 401);
        const raw = await request.text();
        if (Buffer.byteLength(raw) > 30000) return json({ error: 'Too large.' }, 413);
        const input = JSON.parse(raw);
        if (input.action === 'due') return json(await due());
        if (input.action && input.action !== 'schedule') return json({ error: 'Unknown action.' }, 400);
        const inquiryId = bounded(input.inquiry_id, 36);
        if (!/^[a-f0-9-]{36}$/.test(inquiryId)) return json({ error: 'An inquiry id is required.' }, 400);
        const inquiry = await getInquiry(inquiryId);
        if (!inquiry) return json({ error: 'Inquiry not found.' }, 404);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inquiry.email)) return json({ error: 'The inquiry has no usable customer email.' }, 400);
        const steps = Array.isArray(input.steps) ? input.steps.slice(0, 5) : [];
        if (!steps.length) return json({ error: 'At least one follow-up step is required.' }, 400);
        let created = 0;
        for (const [index, step] of steps.entries()) {
          const subject = bounded(step.subject, 200), body = bounded(step.body, 4000), delay = Number(step.delay_days);
          if (!subject || body.length < 20 || !Number.isFinite(delay) || delay < 0 || delay > 30) return json({ error: `Step ${index + 1} needs a subject, a body of at least 20 characters, and a delay from 0 to 30 days.` }, 400);
          await db().execute(sql`INSERT INTO legacy_followup_steps(id,inquiry_id,step,subject,body,due_at) VALUES (${randomUUID()}::uuid,${inquiryId}::uuid,${index + 1},${subject},${body},${new Date(now() + delay * 86400000).toISOString()}::timestamptz)`);
          created++;
        }
        const followLink = link(inquiryId);
        try { await Promise.all(OWNER_ADDRESSES.map(to => mail({ to, subject: `Follow-up plan for ${inquiry.name}`, body: `${created} follow-up step${created === 1 ? '' : 's'} are ready for approval.\n\nCustomer: ${inquiry.name} <${inquiry.email}>\n\nApprove or cancel each step:\n${followLink}\n\nNothing is sent until you approve a step, and only when it is due.` }))); } catch { /* the plan stands even when mail fails */ }
        return json({ ok: true, inquiry_id: inquiryId, created });
      }
      const form = await request.formData();
      const access = readOwnerToken(form.get('token'), env.RECEPTIONIST_SESSION_SECRET, now());
      if (!access || access.scope !== 'followups' || !/^[a-f0-9-]{36}$/.test(access.id || '')) return page('<h1>This link is not valid</h1>', 401);
      const inquiry = await getInquiry(access.id);
      if (!inquiry) return page('<h1>Inquiry not found</h1>', 404);
      const stepId = bounded(form.get('step'), 36), action = form.get('action');
      if (!/^[a-f0-9-]{36}$/.test(stepId) || !['approve', 'cancel'].includes(action)) return page('<h1>Unknown action</h1>', 400);
      const status = action === 'approve' ? 'approved' : 'cancelled';
      // Compete atomically with the sender's approved -> sending claim. A stale
      // approval cannot reactivate a cancellation, and an in-flight send is final.
      const eligible = action === 'cancel' ? sql`status IN ('draft','approved')` : sql`status='draft'`;
      const claimed = await db().execute(sql`UPDATE legacy_followup_steps SET status=${status},approved_at=${action === 'approve' ? sql`now()` : sql`approved_at`} WHERE id=${stepId}::uuid AND inquiry_id=${access.id}::uuid AND ${eligible} RETURNING id`);
      if (!claimed.rows.length) return view(inquiry, await stepsFor(access.id), form.get('token'), 'That step was already handled.');
      try { await Promise.all(OWNER_ADDRESSES.map(to => mail({ to, subject: `Follow-up step ${status}: ${inquiry.name}`, body: `A step for ${inquiry.email} was ${status}. Nothing has been sent to the customer yet unless it was already due.` }))); } catch { /* the decision stands */ }
      return view(inquiry, await stepsFor(access.id), form.get('token'), action === 'approve' ? 'Step approved.' : 'Step cancelled.');
    } catch { return json({ error: 'The follow-up action could not be completed.' }, 500); }
  };
}
