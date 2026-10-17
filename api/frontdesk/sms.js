import { createFrontdeskSmsHandler } from '../../lib/frontdesk-sms.js';
import { createOwnerMailer } from '../../lib/assistant.js';
import { getDb } from '../../lib/concierge/database.js';
export default { fetch: createFrontdeskSmsHandler({ getDb, mail: createOwnerMailer() }) };
