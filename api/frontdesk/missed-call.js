import { createMissedCallLiveHandler } from '../../lib/missed-call-live.js';
import { getDb } from '../../lib/concierge/database.js';

export default { fetch: createMissedCallLiveHandler({ getDb }) };
