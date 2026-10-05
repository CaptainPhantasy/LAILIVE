import { randomUUID, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { HttpError, parse } from './concierge/contracts.js';
import { receptionistInput, groundTurn, requireReceptionistInquiry, consumeReceptionistTurn } from './receptionist.js';
import { chatDefinition, MAX_CALL_SECONDS, PREVIEW_ALIAS, PROJECT_ID } from './receptionist-signalwire.js';

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const hangup = () => ({ version: '1.0.0', sections: { main: [{ hangup: {} }] } });
const safeSpeech = text => text.replace(/\$\{/g, 'dollar brace ').replace(/%\{/g, 'percent brace ');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function checkedVoiceDefinition(turn, { callbackUrl, session, caller = '', step = 0 }) {
  const language = turn.language === 'es' ? 'es-US' : 'en-US';
  const main = [{ user_event: { event: { receptionist: { turn, caller, step } } } }];
  const play = `say:${safeSpeech(turn.reply)}`;
  if (turn.endCall || step >= 8) main.push({ play: { url: play, say_voice: 'openai.alloy', say_language: language } }, { hangup: {} });
  else main.push(
    { prompt: { play, say_voice: 'openai.alloy', say_language: language, speech_language: language, speech_timeout: 15, speech_end_timeout: 1.2 } },
    { transfer: { dest: callbackUrl, params: { session } } },
  );
  return { version: '1.0.0', sections: { main } };
}

async function jsonBody(request, max = 48000) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Send JSON content.');
  if (Number(request.headers.get('content-length') || 0) > max) throw new HttpError(413, 'Request too large.');
  const raw = await request.text();
  if (raw.length > max) throw new HttpError(413, 'Request too large.');
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON request.'); }
}

export function createReceptionistVoiceHandlers({ signalwire, getStore, env = process.env, now = () => new Date(), uuid = randomUUID }) {
  const key = () => new TextEncoder().encode(env.RECEPTIONIST_SESSION_SECRET);
  async function sign(state, origin, expiresAt) {
    return new SignJWT(state).setProtectedHeader({ alg: 'HS256' }).setIssuer(origin).setAudience('receptionist-voice-preview').setExpirationTime(expiresAt).sign(key());
  }
  function webhookAuthorized(request) {
    const expected = Buffer.from(`Basic ${Buffer.from(`receptionist:${env.RECEPTIONIST_WEBHOOK_SECRET}`).toString('base64')}`);
    const actual = Buffer.from(request.headers.get('authorization') || '');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  async function session(request) {
    try {
      signalwire.assertPreview(request); signalwire.voiceConfig();
      if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
      if (request.headers.get('origin') !== new URL(request.url).origin) throw new HttpError(403, 'Use the test line from this website.');
      const input = parse(receptionistInput, await jsonBody(request));
      if (input.messages.length || input.speak) throw new HttpError(400, 'Start a new voice call.');
      const id = request.headers.get('x-legacy-inquiry'), store = getStore();
      await requireReceptionistInquiry(store, id);
      const time = now(), expires = Math.floor(time.getTime() / 1000) + MAX_CALL_SECONDS;
      await store.consumeLimits([
        { key: `receptionist-voice:${time.toISOString().slice(0, 13)}:${id}`, limit: 2, expiresAt: new Date(time.getTime() + 86400000).toISOString() },
        { key: `receptionist-voice:${time.toISOString().slice(0, 10)}`, limit: 10, expiresAt: new Date(time.getTime() + 86400000).toISOString() },
      ]);
      const token = await sign({ inquiry: id, session: uuid(), step: 0, input }, new URL(request.url).origin, expires);
      const guest = await signalwire.guestToken();
      return Response.json({ ...guest, session: token }, { headers });
    } catch (error) {
      return Response.json({ error: error instanceof HttpError ? error.message : 'Browser voice is unavailable. You can start a typed conversation.' }, { status: error instanceof HttpError ? error.status : 503, headers });
    }
  }
  async function swml(request) {
    try {
      signalwire.assertPreview(request);
      const mode = new URL(request.url).searchParams.get('mode');
      if (mode === 'chat' && request.method === 'GET') return Response.json(chatDefinition(), { headers });
      const config = signalwire.voiceConfig();
      if (mode !== 'voice' || request.method !== 'POST' || !webhookAuthorized(request)) throw new HttpError(403, 'Forbidden.');
      const body = await jsonBody(request, 64000), raw = body?.params?.session;
      if (typeof raw !== 'string' || raw.length > 30000) throw new HttpError(403, 'Forbidden.');
      const { payload } = await jwtVerify(raw, key(), { algorithms: ['HS256'], issuer: config.origin, audience: 'receptionist-voice-preview', currentDate: now() });
      if (!UUID.test(payload.session || '') || !Number.isInteger(payload.step) || payload.step < 0 || payload.step > 8 || !UUID.test(body.call?.call_id || '') || body.call?.project_id !== PROJECT_ID || body.call?.type !== 'webrtc' || body.call?.to !== PREVIEW_ALIAS || (payload.callId && payload.callId !== body.call.call_id)) throw new HttpError(403, 'Forbidden.');
      const input = payload.input, store = getStore();
      await requireReceptionistInquiry(store, payload.inquiry);
      // Atomic persistent claim prevents retries or replay spending twice.
      await store.consumeLimits([{ key: `receptionist-voice-step:${payload.session}:${payload.step}`, limit: 1, expiresAt: new Date(payload.exp * 1000).toISOString() }]);
      let caller = '';
      if (payload.step > 0) {
        if (body.vars?.prompt_result !== 'match_speech' || typeof body.vars?.prompt_value !== 'string' || !body.vars.prompt_value.trim() || body.vars.prompt_value.length > 1200) return Response.json(hangup(), { headers });
        caller = body.vars.prompt_value.trim(); input.messages.push({ role: 'caller', content: caller });
      }
      // Validate again after adding speech, before spending a turn allowance.
      const checkedInput = parse(receptionistInput, input);
      await consumeReceptionistTurn(store, payload.inquiry, now());
      const turn = groundTurn(await signalwire.generate(checkedInput), checkedInput);
      const nextInput = { ...input, messages: [...input.messages, { role: 'receptionist', content: turn.reply }] };
      // The next callback appends caller speech before schema validation.
      const next = await sign({ inquiry: payload.inquiry, session: payload.session, step: payload.step + 1, callId: body.call.call_id, input: nextInput }, config.origin, payload.exp);
      return Response.json(checkedVoiceDefinition(turn, { callbackUrl: config.callbackUrl, session: next, caller, step: payload.step }), { headers });
    } catch {
      // Authentication, replay, expired state, consent and provider failures
      // all stop the call without echoing provider data or reading a false claim.
      return Response.json(hangup(), { status: 403, headers });
    }
  }
  return { session, swml };
}
