import { createOwnerPinHandler } from '../../lib/owner-pin.js';
import { createOwnerAuth } from '../../lib/concierge/auth.js';
import { getDb } from '../../lib/concierge/database.js';
export default { fetch: createOwnerPinHandler({ getDb, authorize: createOwnerAuth() }) };
