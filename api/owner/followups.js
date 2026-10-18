import { createFollowupHandler } from '../../lib/followups.js';
import { createOwnerMailer, secretMatches } from '../../lib/assistant.js';
import { getDb } from '../../lib/concierge/database.js';

// Called by Vercel Cron with CRON_SECRET. It sends only steps the owner approved
// whose due time has arrived.
const followups = createFollowupHandler({ getDb, mail: createOwnerMailer() });

export default {
  async fetch(request) {
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
    if (!secretMatches(token, process.env.CRON_SECRET)) return Response.json({ error: 'Not authorized.' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    const internal = new Request('https://internal/api/frontdesk/followups', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-frontdesk-secret': process.env.FOLLOWUP_SECRET || process.env.RECEPTIONIST_WEBHOOK_SECRET },
      body: JSON.stringify({ action: 'due' }),
    });
    const result = await followups(internal);
    return new Response(await result.text(), { status: result.status, headers: { 'Cache-Control': 'no-store' } });
  },
};
