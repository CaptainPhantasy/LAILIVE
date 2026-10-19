import { createOwnerGate } from '../../lib/owner-gate.js';

// Caller-ID gate in front of the public receptionist. Douglas's cell gets the PIN
// prompt; every other caller is transferred to the configured public flow.
export default { fetch: createOwnerGate() };
