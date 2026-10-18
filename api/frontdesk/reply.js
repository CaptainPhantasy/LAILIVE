import { createOwnerReplyHandler } from '../../lib/owner-reply.js';
import { createOwnerMailer } from '../../lib/assistant.js';
import { getDb } from '../../lib/concierge/database.js';
export default { fetch: createOwnerReplyHandler({ getDb, mail: createOwnerMailer() }) };
