import { authBase } from '../../lib/concierge/config.js';
export default { fetch: request => request.method === 'GET' ? Response.json({ authUrl: authBase }, { headers: { 'Cache-Control': 'no-store' } }) : new Response(null, { status: 405 }) };
