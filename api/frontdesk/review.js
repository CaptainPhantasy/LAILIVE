import { createReviewRequestHandler } from '../../lib/review-requests.js';
import { createOwnerMailer } from '../../lib/assistant.js';
import { getDb } from '../../lib/concierge/database.js';

// Owner approval is required before any customer email. Ratings return here first;
// low ratings stay private and high ratings may offer a configured public link.
export default { fetch: createReviewRequestHandler({ getDb, mail: createOwnerMailer() }) };
