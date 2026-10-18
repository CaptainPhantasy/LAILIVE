import { createInvoiceHandler } from '../../lib/invoices.js';
import { createOwnerMailer, secretMatches } from '../../lib/assistant.js';
import { getDb } from '../../lib/concierge/database.js';

// Called by Vercel Cron with CRON_SECRET. It only notifies the owners about due
// invoices; it never emails a customer.
const handler = createInvoiceHandler({ getDb, mail: createOwnerMailer() });

export default {
  async fetch(request) {
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
    if (!secretMatches(token, process.env.CRON_SECRET)) return Response.json({ error: 'Not authorized.' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    const internal = new Request('https://internal/api/frontdesk/invoices', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-frontdesk-secret': process.env.INVOICE_SECRET || process.env.RECEPTIONIST_WEBHOOK_SECRET },
      body: JSON.stringify({ action: 'chase' }),
    });
    const result = await handler(internal);
    return new Response(await result.text(), { status: result.status, headers: { 'Cache-Control': 'no-store' } });
  },
};
