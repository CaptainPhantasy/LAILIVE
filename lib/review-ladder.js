import { sql } from 'drizzle-orm';
import { OWNER_ADDRESSES } from './frontdesk.js';
import { ensureReviewSchema } from './review-requests.js';

// A request that was approved but never answered gets one owner-facing nudge.
// No second customer email is sent and nothing is posted publicly.
export function createReviewLadder({ getDb, mail, env = process.env, now = Date.now, days = 7 } = {}) {
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
    const rows = (await db.execute(sql`SELECT job_id, customer_name, status FROM legacy_review_requests WHERE id IN (${list})`)).rows;
    const pending = rows.map(row => ({ job: row.job_id, customer: row.customer_name, status: row.status }));
    const lines = pending.map((item, index) => `${index + 1}. ${item.customer} — job ${item.job} — ${item.status}`).join('\n');
    try {
      await Promise.all(OWNER_ADDRESSES.map(to => mail({ to, subject: `${pending.length} review request${pending.length === 1 ? '' : 's'} waiting`, body: `These review requests were approved at least ${days} days ago and have no rating yet:\n\n${lines}\n\nNo second customer email was sent. Open the review list to decide whether to follow up.` })));
    } catch { /* the nudges are recorded even when the email fails */ }
    return { nudged: pending.length, pending };
  };
}
