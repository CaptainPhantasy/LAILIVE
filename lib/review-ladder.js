import { sql } from 'drizzle-orm';
import { OWNER_ADDRESSES } from './frontdesk.js';
import { ensureReviewSchema } from './review-requests.js';
import { signOwnerToken } from './owner-documents-core.js';

// A request that was approved but never answered gets one owner-facing nudge with
// a link to approve at most one second customer ask. Nothing is sent without that
// approval and nothing is posted publicly.
export function createReviewLadder({ getDb, mail, env = process.env, now = Date.now, days = 7 } = {}) {
  const origin = () => new URL(env.FRONTDESK_PUBLIC_ORIGIN || 'https://legacyai.space').origin;
  const secondLink = id => `${origin()}/api/frontdesk/review?token=${signOwnerToken({ id, scope: 'review-second', exp: now() + 14 * 86400000 }, env.RECEPTIONIST_SESSION_SECRET)}`;
  return async function run() {
    const db = getDb();
    await ensureReviewSchema(db);
    const cutoff = new Date(now() - days * 86400000).toISOString();
    const inserted = await db.execute(sql`INSERT INTO legacy_review_events(request_id,event,detail)
      SELECT r.id,'ladder_nudge',${`${days}-day owner nudge`}
      FROM legacy_review_requests r
      WHERE r.status IN ('approved','opened') AND r.updated_at < ${cutoff}::timestamptz
        AND NOT EXISTS (SELECT 1 FROM legacy_review_events e WHERE e.request_id=r.id AND e.event='ladder_nudge')
      RETURNING request_id`);
    const ids = inserted.rows.map(row => row.request_id);
    if (!ids.length) return { nudged: 0, pending: [] };
    const list = sql.join(ids.map(id => sql`${id}::uuid`), sql`, `);
    const rows = (await db.execute(sql`SELECT id, job_id, customer_name, status FROM legacy_review_requests WHERE id IN (${list})`)).rows;
    const pending = rows.map(row => ({ job: row.job_id, customer: row.customer_name, status: row.status }));
    const lines = rows.map((row, index) => `${index + 1}. ${row.customer_name} — job ${row.job_id} — ${row.status}\n   Approve one second ask: ${secondLink(row.id)}`).join('\n');
    try {
      await Promise.all(OWNER_ADDRESSES.map(to => mail({ to, subject: `${pending.length} review request${pending.length === 1 ? '' : 's'} waiting`, body: `These review requests were approved at least ${days} days ago and have no rating yet:\n\n${lines}\n\nNo second customer email was sent. Each link above allows exactly one approved second ask, then closes.` })));
    } catch { /* the nudges are recorded even when the email fails */ }
    return { nudged: pending.length, pending };
  };
}
