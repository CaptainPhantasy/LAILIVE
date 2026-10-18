import { createOwnerDocumentHandler } from '../../lib/owner-documents.js';
import { createOwnerMailer } from '../../lib/assistant.js';
import { getDb } from '../../lib/concierge/database.js';
import { createBoardGenerator } from '../../lib/board-generate.js';
export default { fetch: createOwnerDocumentHandler({ getDb, mail: createOwnerMailer(), generateBoard: createBoardGenerator() }).document };
