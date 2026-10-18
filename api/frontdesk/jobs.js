import { createJobHandler } from '../../lib/jobs.js';
import { createOwnerMailer } from '../../lib/assistant.js';
import { getDb } from '../../lib/concierge/database.js';

// The technician opens one signed link per job. Each tap advances one step and
// writes a receipt; completion emails the owners once.
export default { fetch: createJobHandler({ getDb, mail: createOwnerMailer() }) };
