import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { HttpError } from './concierge/contracts.js';

// Completed sessions belong to the saved inquiry, independently of browser
// storage. A short claim serializes generation and recovers from a dead worker.
export function createBoardSessions(db) {
  let ready;
  const ensure = () => ready ||= (async () => {
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_board_sessions (
      inquiry_id uuid PRIMARY KEY REFERENCES legacy_inquiries(id) ON DELETE CASCADE,
      completed integer NOT NULL DEFAULT 0,
      claim_id uuid,
      claim_until timestamptz
    )`));
    await db.execute(sql.raw('ALTER TABLE legacy_board_sessions ENABLE ROW LEVEL SECURITY'));
  })().catch(error => { ready = undefined; throw error; });
  return {
    async claimBoardSession(inquiryId, allowRepeat, time = Date.now()) {
      await ensure();
      const claim = randomUUID(), at = new Date(time).toISOString(), until = new Date(time + 120000).toISOString();
      const result = await db.execute(sql`INSERT INTO legacy_board_sessions(inquiry_id,claim_id,claim_until)
        VALUES (${inquiryId}::uuid,${claim}::uuid,${until}::timestamptz)
        ON CONFLICT(inquiry_id) DO UPDATE SET claim_id=EXCLUDED.claim_id,claim_until=EXCLUDED.claim_until
        WHERE (legacy_board_sessions.claim_until IS NULL OR legacy_board_sessions.claim_until <= ${at}::timestamptz)
          AND (legacy_board_sessions.completed=0 OR ${allowRepeat}) RETURNING claim_id`);
      if (result.rows.length) return claim;
      const existing = (await db.execute(sql`SELECT completed FROM legacy_board_sessions WHERE inquiry_id=${inquiryId}::uuid`)).rows[0];
      if (existing?.completed > 0 && !allowRepeat) throw new HttpError(403, 'Additional Board sessions are available during business hours when enabled. Please return then or talk with Douglas about your next decision.');
      throw new HttpError(409, 'A Board report is already being generated for this inquiry. Please wait for it to finish.');
    },
    async finishBoardSession(inquiryId, claim, completed) {
      await ensure();
      await db.execute(sql`UPDATE legacy_board_sessions SET completed=completed+${completed ? 1 : 0},claim_id=NULL,claim_until=NULL
        WHERE inquiry_id=${inquiryId}::uuid AND claim_id=${claim}::uuid`);
    },
  };
}
