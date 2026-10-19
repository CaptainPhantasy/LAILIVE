import { createOwnerSwml } from '../../lib/owner-swml.js';

// Answers the phone line's question "what do I do with this call?". The owner's
// cell gets a keypad PIN prompt; everyone else is forwarded to the receptionist.
export default { fetch: createOwnerSwml() };
