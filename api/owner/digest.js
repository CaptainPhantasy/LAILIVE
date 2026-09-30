import { assistantHandlers } from '../../lib/assistant-runtime.js';
// Called by Vercel Cron with the CRON_SECRET bearer token, not the owner sign-in.
export default { fetch: assistantHandlers.digest };
