import { createTenantHandler } from '../../lib/tenant-config.js';
import { getDb } from '../../lib/concierge/database.js';

// Validates and stores the six intake inputs for a new client. Facts must come
// from the owner; placeholders are refused.
export default { fetch: createTenantHandler({ getDb }) };
