import { createReviewResponseHandler } from '../../lib/review-responses.js';
import { createOwnerMailer } from '../../lib/assistant.js';
import { getDb } from '../../lib/concierge/database.js';

// A reply is drafted for the owner to edit and approve. Nothing is posted to a
// review platform and no customer email is sent by this code.
export default { fetch: createReviewResponseHandler({ getDb, mail: createOwnerMailer() }) };
