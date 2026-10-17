import { createLiveBookingHandler } from '../../lib/booking-live.js';
import { getDb } from '../../lib/concierge/database.js';
export default { fetch: createLiveBookingHandler({ getDb }) };
