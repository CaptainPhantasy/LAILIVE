import { createContentWriter } from '../../lib/content-writer.js';
import { createOwnerMailer } from '../../lib/assistant.js';
import { getDb } from '../../lib/concierge/database.js';

// A topic becomes a draft the owner edits and approves. Nothing is published.
export default { fetch: createContentWriter({ getDb, mail: createOwnerMailer() }) };
