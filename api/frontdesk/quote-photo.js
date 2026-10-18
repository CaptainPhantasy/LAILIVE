import { createQuotePhotoHandler } from '../../lib/quote-photo.js';
import { createOwnerMailer } from '../../lib/assistant.js';
import { getDb } from '../../lib/concierge/database.js';

// A photo and note become a draft the owner must price. No measurement or price
// is generated, and nothing is sent to a customer.
export default { fetch: createQuotePhotoHandler({ getDb, mail: createOwnerMailer() }) };
