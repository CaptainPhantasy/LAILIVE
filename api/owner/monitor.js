import { createMonitor } from '../../lib/monitoring.js';
import { createOwnerMailer, secretMatches } from '../../lib/assistant.js';
import { getDb } from '../../lib/concierge/database.js';

// Called by Vercel Cron with CRON_SECRET. It checks the live site and TLS, writes
// a hashed application export, verifies it, and emails the receipt on the 1st.
const monitor = createMonitor({ getDb, mail: createOwnerMailer() });

export default {
  async fetch(request) {
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
    if (!secretMatches(token, process.env.CRON_SECRET)) return Response.json({ error: 'Not authorized.' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    try {
      const daily = await monitor.daily();
      const monthly = new Date().getUTCDate() === 1 ? await monitor.emailReceipt() : null;
      return Response.json({ daily, monthly: Boolean(monthly) }, { headers: { 'Cache-Control': 'no-store' } });
    } catch {
      return Response.json({ error: 'The monitoring run could not be completed.' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
    }
  },
};
