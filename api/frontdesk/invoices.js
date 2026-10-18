import { createInvoiceHandler } from '../../lib/invoices.js';
import { createOwnerMailer } from '../../lib/assistant.js';
import { getDb } from '../../lib/concierge/database.js';

// Manual invoicing: register amounts, mark paid, and approve the exact reminder
// text before any customer email is sent.
export default { fetch: createInvoiceHandler({ getDb, mail: createOwnerMailer() }) };
