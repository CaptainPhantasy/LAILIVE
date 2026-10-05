import { getStore } from '../lib/concierge/database.js';
import { createSignalWireReceptionist } from '../lib/receptionist-signalwire.js';
import { createReceptionistVoiceHandlers } from '../lib/receptionist-swml.js';
export default { fetch: createReceptionistVoiceHandlers({ signalwire: createSignalWireReceptionist(), getStore }).swml };
