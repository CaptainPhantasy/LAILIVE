import { createSubscriptionAuditHandler } from '../../lib/subscription-audit.js';
import { createOwnerMailer } from '../../lib/assistant.js';
import { getDb } from '../../lib/concierge/database.js';

// Groups repeated statement charges into likely subscriptions. It cancels nothing.
export default { fetch: createSubscriptionAuditHandler({ getDb, mail: createOwnerMailer() }) };
