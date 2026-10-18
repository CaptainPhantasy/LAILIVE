import { createProspectHunter } from '../../lib/prospects.js';
import { createOwnerMailer, secretMatches } from '../../lib/assistant.js';
import { getDb } from '../../lib/concierge/database.js';

// Called by Vercel Cron with CRON_SECRET. It reports prospects to the owners and
// never contacts them.
const hunter = createProspectHunter({ getDb, mail: createOwnerMailer() });

export default {
  async fetch(request) {
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
    if (!secretMatches(token, process.env.CRON_SECRET)) return Response.json({ error: 'Not authorized.' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    const internal = new Request('https://internal/api/frontdesk/prospects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-frontdesk-secret': process.env.PROSPECT_SECRET || process.env.RECEPTIONIST_WEBHOOK_SECRET },
      body: JSON.stringify({ action: 'hunt' }),
    });
    const result = await hunter(internal);
    return new Response(await result.text(), { status: result.status, headers: { 'Cache-Control': 'no-store' } });
  },
};
