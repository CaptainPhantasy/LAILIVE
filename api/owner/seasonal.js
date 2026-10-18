import { createSeasonal } from '../../lib/seasonal.js';
import { createOwnerMailer, secretMatches } from '../../lib/assistant.js';
import { getDb } from '../../lib/concierge/database.js';

// Called by Vercel Cron with CRON_SECRET. It creates drafts, never publishes.
const seasonal = createSeasonal({ getDb, mail: createOwnerMailer() });

export default {
  async fetch(request) {
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
    if (!secretMatches(token, process.env.CRON_SECRET)) return Response.json({ error: 'Not authorized.' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    const internal = new Request('https://internal/api/frontdesk/seasonal', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-frontdesk-secret': process.env.SEASONAL_SECRET || process.env.RECEPTIONIST_WEBHOOK_SECRET },
      body: JSON.stringify({ action: 'run' }),
    });
    const result = await seasonal(internal);
    return new Response(await result.text(), { status: result.status, headers: { 'Cache-Control': 'no-store' } });
  },
};
