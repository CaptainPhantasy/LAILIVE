import { createProspectHunter } from '../../lib/prospects.js';
import { createOwnerMailer } from '../../lib/assistant.js';
import { getDb } from '../../lib/concierge/database.js';

// Works only from the owner's supplied list. No scraping, no outreach.
export default { fetch: createProspectHunter({ getDb, mail: createOwnerMailer() }) };
