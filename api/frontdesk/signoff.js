import { createSignoffHandler } from '../../lib/signoffs.js';
import { createOwnerMailer } from '../../lib/assistant.js';
import { getDb } from '../../lib/concierge/database.js';

// The customer types their name on a delivered document. The signature is a
// stored receipt and a signed PDF; no third-party signing service is involved.
export default { fetch: createSignoffHandler({ getDb, mail: createOwnerMailer() }) };
