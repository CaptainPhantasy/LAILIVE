import { createContactImportHandler } from '../../lib/import-contacts.js';
import { createOwnerMailer } from '../../lib/assistant.js';
import { getDb } from '../../lib/concierge/database.js';

// Preview counts what would land; commit inserts only valid, new contacts.
// No customer is emailed and no existing record is merged.
export default { fetch: createContactImportHandler({ getDb, mail: createOwnerMailer() }) };
