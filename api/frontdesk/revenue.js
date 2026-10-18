import { createRevenueHandler } from '../../lib/revenue.js';
import { createOwnerMailer } from '../../lib/assistant.js';
import { getDb } from '../../lib/concierge/database.js';

// Groups invoiced and paid cents by the source recorded on each job. Ad spend is
// not part of this report and no money is moved.
export default { fetch: createRevenueHandler({ getDb, mail: createOwnerMailer() }) };
