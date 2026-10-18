import { createCompetitorWatch } from '../../lib/competitor-watch.js';
import { createOwnerMailer } from '../../lib/assistant.js';
import { getDb } from '../../lib/concierge/database.js';

// Watches public competitor pages the owner names and alerts on text changes.
export default { fetch: createCompetitorWatch({ getDb, mail: createOwnerMailer() }) };
