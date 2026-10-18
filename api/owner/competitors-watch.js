import { createCompetitorWatch } from '../../lib/competitor-watch.js';
import { createOwnerMailer, secretMatches } from '../../lib/assistant.js';
import { getDb } from '../../lib/concierge/database.js';

// Called by Vercel Cron with CRON_SECRET. It records changes and alerts the owners.
const watch = createCompetitorWatch({ getDb, mail: createOwnerMailer() });

export default {
  async fetch(request) {
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
    if (!secretMatches(token, process.env.CRON_SECRET)) return Response.json({ error: 'Not authorized.' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    const internal = new Request('https://internal/api/frontdesk/competitors-watch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-frontdesk-secret': process.env.COMPETITOR_SECRET || process.env.RECEPTIONIST_WEBHOOK_SECRET },
      body: JSON.stringify({ action: 'check' }),
    });
    const result = await watch(internal);
    return new Response(await result.text(), { status: result.status, headers: { 'Cache-Control': 'no-store' } });
  },
};
