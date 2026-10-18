import { createOwnerJobsHandler } from '../../lib/owner-jobs.js';
import { createOwnerAuth } from '../../lib/concierge/auth.js';
import { getDb } from '../../lib/concierge/database.js';

// Session-authenticated job list for the owner workspace.
export default { fetch: createOwnerJobsHandler({ getDb, requireOwner: createOwnerAuth() }) };
