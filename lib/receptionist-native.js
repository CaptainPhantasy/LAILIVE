// A server-only guest credential restricted to the Legacy AI voice address.
// No AI Chat, webhook secret, signing secret, inquiry receipt or database.
const PROJECT = '2f9ce47f-c556-4cf2-803c-2b1525b35b34';
const ADDRESS = 'ff610195-c5b4-44f8-ae1e-9cf4e0d77e54';
const DESTINATION = '/private/legacyai-receptionist-preview';
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
export function createNativeReceptionistSession({ env = process.env, fetcher = fetch, now = Date.now } = {}) {
  return async request => {
    const fail = (status, error) => Response.json({ error }, { status, headers });
    if (request.method !== 'POST') return fail(405, 'Method not allowed.');
    let origin;
    try {
      if (!env.RECEPTIONIST_PREVIEW_ORIGIN && !env.VERCEL_URL) throw new Error();
      origin = new URL(env.RECEPTIONIST_PREVIEW_ORIGIN || `https://${env.VERCEL_URL}`);
      if (env.VERCEL_ENV !== 'preview' || env.RECEPTIONIST_SIGNALWIRE_ENABLED !== 'true' || origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || ['legacyai.space', 'www.legacyai.space'].includes(origin.hostname) || env.SIGNALWIRE_SPACE_HOST !== 'legacyai.signalwire.com' || env.SIGNALWIRE_PROJECT_ID !== PROJECT || env.SIGNALWIRE_RECEPTIONIST_ADDRESS_ID !== ADDRESS || !env.SIGNALWIRE_API_TOKEN) throw new Error();
    } catch { return fail(503, 'The Legacy AI voice line is not enabled yet.'); }
    if (new URL(request.url).origin !== origin.origin || request.headers.get('origin') !== origin.origin) return fail(403, 'Start the call from this Legacy AI page.');
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return fail(415, 'Send JSON content.');
    if (Number(request.headers.get('content-length') || 0) > 256) return fail(413, 'Request too large.');
    try {
      const reader = request.body?.getReader();
      if (!reader) return fail(400, 'Review the call notice before starting.');
      let raw = '', bytes = 0; const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          bytes += value.byteLength;
          if (bytes > 256) { await reader.cancel(); return fail(413, 'Request too large.'); }
          raw += decoder.decode(value, { stream: true });
        }
        raw += decoder.decode();
      } finally { reader.releaseLock(); }
      const body = JSON.parse(raw);
      if (body?.consent !== true || Object.keys(body).length !== 1) return fail(400, 'Review the call notice before starting.');
      // This short-lived credential admits a new connection. Its expiry is not
      // a deadline for an established call. SDK v4 rejects stale credentials.
      const expiresAt = Math.floor(now() / 1000) + 120;
      const response = await fetcher('https://legacyai.signalwire.com/api/fabric/guests/tokens', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { authorization: `Basic ${Buffer.from(`${PROJECT}:${env.SIGNALWIRE_API_TOKEN}`).toString('base64')}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ allowed_addresses: [ADDRESS], expire_at: expiresAt }),
      });
      if (!response.ok) return fail(503, 'Voice access could not be created.');
      const rawResponse = await response.text();
      if (rawResponse.length > 80000) throw new Error();
      const value = JSON.parse(rawResponse);
      if (typeof value.token !== 'string' || !value.token || value.token.length > 12000) throw new Error();
      return Response.json({ token: value.token, expiresAt, destination: DESTINATION }, { headers });
    } catch { return fail(503, 'Voice access could not be created.'); }
  };
}
