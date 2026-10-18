import { createUpsellHandler } from '../../lib/upsells.js';
import { createOwnerMailer } from '../../lib/assistant.js';
import { getDb } from '../../lib/concierge/database.js';

// A job-specific add-on the owner approves or declines. Nothing is sent to the
// customer and no price is invented.
export default { fetch: createUpsellHandler({ getDb, mail: createOwnerMailer() }) };
