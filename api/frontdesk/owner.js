import { createOwnerDocumentHandler } from '../../lib/owner-documents.js';
import { createOwnerMailer } from '../../lib/assistant.js';
import { getDb } from '../../lib/concierge/database.js';
export default { fetch: createOwnerDocumentHandler({ getDb, mail: createOwnerMailer() }).owner };
