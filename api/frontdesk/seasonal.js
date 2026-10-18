import { createSeasonal } from '../../lib/seasonal.js';
import { createOwnerMailer } from '../../lib/assistant.js';
import { getDb } from '../../lib/concierge/database.js';

// A seasonal rule creates one owner-reviewed draft per year. Nothing publishes.
export default { fetch: createSeasonal({ getDb, mail: createOwnerMailer() }) };
