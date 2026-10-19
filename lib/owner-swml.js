import { OWNER_NUMBER, frontdeskSecret } from './frontdesk.js';
import { secretMatches } from './assistant.js';
import { signOwnerToken } from './owner-documents-core.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const say = text => ({ play: { url: `say:${text}`, say_voice: 'openai.alloy' } });
const transfer = dest => ({ transfer: { dest } });

// The phone line asks this endpoint what to do with a call. Only the owner's cell
// gets the PIN prompt; every other caller is handed to the normal receptionist.
// The prompt collects keypad digits, so no speech recognition is involved.
export function createOwnerSwml({ env = process.env, now = Date.now } = {}) {
  const origin = () => new URL(env.FRONTDESK_PUBLIC_ORIGIN || 'https://legacyai.space').origin;
  return async request => {
    try {
      if (request.method !== 'POST') return json({ error: 'POST required.' }, 405);
      if (!env.RECEPTIONIST_WEBHOOK_SECRET) return json({ error: 'Not configured.' }, 503);
      const authorized = frontdeskSecret(request).some(value => secretMatches(value, env.RECEPTIONIST_WEBHOOK_SECRET))
        || secretMatches(new URL(request.url).searchParams.get('secret') || '', env.RECEPTIONIST_WEBHOOK_SECRET);
      if (!authorized) return json({ error: 'Not authorized.' }, 401);
      if (Number(request.headers.get('content-length') || 0) > 16000) return json({ error: 'Too large.' }, 413);
      const raw = await request.text();
      if (Buffer.byteLength(raw) > 16000) return json({ error: 'Too large.' }, 413);
      const body = JSON.parse(raw || '{}');
      const call = body.call || body;
      const caller = String(call.from || call.caller || '');
      const callId = String(body.call?.call_id || call.call_id || call.id || '').slice(0, 120);

      // Anyone who is not the owner keeps the normal experience. This endpoint never
      // changes a public caller's call, it only forwards it.
      if (caller !== OWNER_NUMBER) return json({ version: '1.0.0', sections: { main: [transfer(`${origin()}/api/receptionist-swml?mode=voice`)] } });
      if (!callId) return json({ version: '1.0.0', sections: { main: [say('Owner access is unavailable. Please call Douglas directly.'), { hangup: {} }] } });

      // A short-lived signed token replaces the webhook secret in the transfer URL,
      // so the secret never appears in a call log.
      const session = signOwnerToken({ callId, scope: 'owner-pin', exp: now() + 10 * 60000 }, env.RECEPTIONIST_SESSION_SECRET);
      const dest = `${origin()}/api/frontdesk/owner?session=${encodeURIComponent(session)}`;
      return json({ version: '1.0.0', sections: { main: [
        say('Enter your PIN, then press pound.'),
        { prompt: { play: 'say:Enter your PIN, then press pound.', say_voice: 'openai.alloy', max_digits: 8, terminators: '#', digit_timeout: 5, initial_timeout: 7 } },
        transfer(dest),
      ] } });
    } catch { return json({ error: 'The owner handoff could not be prepared.' }, 500); }
  };
}
