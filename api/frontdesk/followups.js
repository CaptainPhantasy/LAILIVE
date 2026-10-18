import { createFollowupHandler } from '../../lib/followups.js';
import { createOwnerMailer } from '../../lib/assistant.js';
import { getDb } from '../../lib/concierge/database.js';

// Only owner-approved steps send, and only when due.
export default { fetch: createFollowupHandler({ getDb, mail: createOwnerMailer() }) };
