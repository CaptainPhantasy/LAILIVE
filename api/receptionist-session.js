import { createNativeReceptionistSession } from '../lib/receptionist-native.js';
import { getStore } from '../lib/concierge/database.js';
export default { fetch: createNativeReceptionistSession({ getStore }) };
