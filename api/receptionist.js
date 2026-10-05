import { createReceptionistHandler } from '../lib/receptionist.js';
import { getStore } from '../lib/concierge/database.js';
import { createSignalWireReceptionist } from '../lib/receptionist-signalwire.js';

const signalwire = createSignalWireReceptionist();
const handler = createReceptionistHandler({ generate: signalwire.generate, getStore });
export default { fetch: async request => {
  try { signalwire.assertPreview(request); }
  catch { return Response.json({ error: 'This preview test line is not connected yet.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
  return handler(request);
} };
