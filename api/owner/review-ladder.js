import { createReviewLadder } from '../../lib/review-ladder.js';
import { createOwnerMailer, secretMatches } from '../../lib/assistant.js';
import { getDb } from '../../lib/concierge/database.js';

// Called by Vercel Cron with the CRON_SECRET bearer token. It never emails a
// customer; it records one nudge per stale request and reports to the owners.
const run = createReviewLadder({ getDb, mail: createOwnerMailer() });

export default {
  async fetch(request) {
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
    if (!secretMatches(token, process.env.CRON_SECRET)) return Response.json({ error: 'Not authorized.' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    try {
      return Response.json(await run(), { headers: { 'Cache-Control': 'no-store' } });
    } catch {
      return Response.json({ error: 'The review ladder could not be completed.' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
    }
  },
};
