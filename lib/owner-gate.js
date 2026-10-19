// Caller-ID gate for the owner line. If Douglas calls from his cell, the call is
// asked for the PIN before anything else; everyone else is handed to the existing
// public flow untouched. No phrase is spoken, so nothing can be misheard.

const OWNER_CALLER = '+18123405761';
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

const normalize = value => {
  const raw = String(value ?? '').replace(/[^\d+]/g, '');
  if (raw.startsWith('+')) return raw;
  if (raw.length === 10) return `+1${raw}`;
  if (raw.length === 11 && raw.startsWith('1')) return `+${raw}`;
  return raw;
};

export function createOwnerGate({ env = process.env } = {}) {
  const secret = () => env.RECEPTIONIST_WEBHOOK_SECRET;
  const owner = () => env.OWNER_GATE_NUMBER || OWNER_CALLER;
  const fallback = () => env.OWNER_GATE_FALLBACK_URL;

  return async request => {
    try {
      if (request.method !== 'POST') return json({ error: 'POST required.' }, 405);
      const expected = secret() ? `Basic ${Buffer.from(`receptionist:${secret()}`).toString('base64')}` : '';
      const actual = request.headers.get('authorization') || '';
      if (!expected || actual.length !== expected.length || actual !== expected) return json({ error: 'Forbidden.' }, 403);

      const body = await request.json().catch(() => null);
      const from = normalize(body?.call?.from);

      if (from && from === normalize(owner())) {
        const target = new URL('/api/frontdesk/owner', new URL(request.url).origin);
        target.username = 'receptionist';
        target.password = secret();
        return json({
          version: '1.0.0',
          sections: { main: [
            // No speech parameters, so SWML collects keypad digits only.
            { prompt: { play: 'say:Enter your PIN, then press pound.', max_digits: 12, terminators: '#', digit_timeout: 5 } },
            { transfer: { dest: target.toString() } },
          ] },
        });
      }

      if (!fallback()) return json({ error: 'Owner gate fallback is not configured.' }, 503);
      return json({ version: '1.0.0', sections: { main: [{ transfer: { dest: fallback() } }] } });
    } catch {
      return json({ error: 'The owner gate could not answer.' }, 500);
    }
  };
}

export { OWNER_CALLER, normalize };
