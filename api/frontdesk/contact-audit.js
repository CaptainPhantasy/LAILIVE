import { createContactAuditHandler } from '../../lib/contact-audit.js';
import { createOwnerMailer } from '../../lib/assistant.js';
import { getDb } from '../../lib/concierge/database.js';
export default { fetch: createContactAuditHandler({ getDb, mail: createOwnerMailer() }) };
