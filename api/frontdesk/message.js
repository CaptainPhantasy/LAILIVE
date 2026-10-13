import { createFrontdeskHandler } from '../../lib/frontdesk.js';
import { createOwnerMailer } from '../../lib/assistant.js';
import { getDb } from '../../lib/concierge/database.js';

// SignalWire's AI receptionist posts the report for each finished call here, with
// the shared secret in the URL. The report is stored, emailed to both owner
// addresses and texted to the owner's phone.
export default { fetch: createFrontdeskHandler({ getDb, mail: createOwnerMailer() }) };
