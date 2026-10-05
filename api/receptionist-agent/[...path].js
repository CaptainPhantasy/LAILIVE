import { getStore } from '../../lib/concierge/database.js';
import { createConciergeFetch } from '../../lib/receptionist-concierge.js';
export default { fetch: createConciergeFetch({ getStore }) };
