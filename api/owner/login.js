import { createOwnerLogin } from '../../lib/owner-login.js';
import { getDb } from '../../lib/concierge/database.js';
export default { fetch: createOwnerLogin({ getDb }) };
