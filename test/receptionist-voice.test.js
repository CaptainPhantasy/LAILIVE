import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSignalWireReceptionist, PROJECT_ID, PREVIEW_ALIAS, chatDefinition, voiceEntryDefinition } from '../lib/receptionist-signalwire.js';
import { createReceptionistVoiceHandlers, checkedVoiceDefinition } from '../lib/receptionist-swml.js';
import { createReceptionistHandler, groundTurn, receptionistInput } from '../lib/receptionist.js';
import { HttpError } from '../lib/concierge/contracts.js';

// All tokens, inquiry IDs and HTTP responses are synthetic. No real provider,
// database, guest token creation, microphone, TTS or media connection is used.
const inquiry = '3351ea89-24df-4b67-9364-8d57c538a6be';
const address = '11111111-2222-4333-8444-555555555555';
const callId = '66666666-2222-4333-8444-555555555555';
const origin = 'https://receptionist-preview.example.test';
const env = { VERCEL_ENV: 'preview', RECEPTIONIST_SIGNALWIRE_ENABLED: 'true', RECEPTIONIST_PREVIEW_ORIGIN: origin, SIGNALWIRE_SPACE_HOST: 'legacyai.signalwire.com', SIGNALWIRE_PROJECT_ID: PROJECT_ID, SIGNALWIRE_API_TOKEN: 'test-project-secret', SIGNALWIRE_RECEPTIONIST_ADDRESS_ID: address, RECEPTIONIST_SESSION_SECRET: 'test-session-signing-secret-at-least-32-bytes', RECEPTIONIST_WEBHOOK_SECRET: 'test-callback-secret-at-least-32-bytes' };
const input = receptionistInput.parse({ profile: { business: 'Acme', hours: '8-5', languages: ['en', 'es'] }, slots: [], messages: [] });
const output = { reply: 'Your appointment is confirmed and an email was sent.', language: 'en', caller: { name: '', callback: '', reason: '' }, booking: { slotId: 'invented', status: 'held' }, followUp: 'I sent the confirmation.', endCall: false };
const granted = { getInquiry: async () => ({ consent: [{ purpose: 'inquiry-reply', choice: 'granted' }] }), consumeLimits: async () => {} };
const req = (path, body, headers = {}) => new Request(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-legacy-inquiry': inquiry, ...headers }, body: JSON.stringify(body) });
const auth = `Basic ${Buffer.from(`receptionist:${env.RECEPTIONIST_WEBHOOK_SECRET}`).toString('base64')}`;
const callback = token => req('/api/receptionist-swml?mode=voice', { params: { session: token }, call: { call_id: callId, project_id: PROJECT_ID, type: 'webrtc', to: PREVIEW_ALIAS } }, { authorization: auth });
function provider(log) { return async (url, options) => {
  const body = JSON.parse(options.body); log.push({ url, options, body });
  if (url.endsWith('/api/fabric/guests/tokens')) return Response.json({ token: 'test-guest-token', refresh_token: 'test-refresh-secret' });
  return Response.json({ id: body.id, jsonrpc: '2.0', result: body.method === 'chat' ? { response: JSON.stringify(output) } : { id: body.params.id, status: 'deleted' } });
}; }

test('guest token reaches exactly the new address UUID and never returns server or refresh credentials', async () => {
  const log = [], transport = createSignalWireReceptionist({ env, fetcher: provider(log), now: () => new Date('2026-10-05T12:00:00Z') });
  const access = await transport.guestToken();
  assert.equal(log.length, 1);
  assert.equal(log[0].url, 'https://legacyai.signalwire.com/api/fabric/guests/tokens');
  assert.deepEqual(log[0].body, { allowed_addresses: [address], expire_at: 1791201780 });
  assert.equal(log[0].options.redirect, 'error');
  assert.equal(access.destination, PREVIEW_ALIAS);
  assert.equal(access.token, 'test-guest-token');
  assert.doesNotMatch(JSON.stringify(access), /test-project-secret|test-refresh-secret|refresh_token/);
  assert.equal(Buffer.from(log[0].options.headers.authorization.slice(6), 'base64').toString(), `${PROJECT_ID}:test-project-secret`);
});

test('production, disabled settings, wrong project/host, and existing Rachael address fail before outbound access', async () => {
  let calls = 0;
  for (const over of [{ VERCEL_ENV: 'production' }, { RECEPTIONIST_SIGNALWIRE_ENABLED: '' }, { RECEPTIONIST_PREVIEW_ORIGIN: 'https://legacyai.space' }, { SIGNALWIRE_SPACE_HOST: 'attacker.example.test' }, { SIGNALWIRE_PROJECT_ID: address }, { SIGNALWIRE_RECEPTIONIST_ADDRESS_ID: 'fec04e82-9db7-4dab-acc5-d8b72b6a6e80' }]) {
    const transport = createSignalWireReceptionist({ env: { ...env, ...over }, fetcher: async () => { calls++; assert.fail(); } });
    await assert.rejects(transport.guestToken());
  }
  const transport = createSignalWireReceptionist({ env });
  assert.throws(() => transport.assertPreview(new Request('https://legacyai.space/api/receptionist')));
  assert.equal(calls, 0);
});

test('AI text uses chat JSON-RPC with a publicly reachable SWML URL and deletes the temporary conversation', async () => {
  const log = [], transport = createSignalWireReceptionist({ env, fetcher: provider(log) });
  assert.deepEqual(await transport.generate(input), { ...output, topic: 'message', serviceName: '' });
  assert.deepEqual(log.map(x => x.body.method), ['chat', 'delete']);
  assert.equal(log[0].url, 'https://legacyai.signalwire.com/api/ai/chat');
  assert.equal(log[0].body.jsonrpc, '2.0');
  assert.equal(log[0].body.params.config_url, `${origin}/api/receptionist-swml?mode=chat`);
  assert.equal(log[0].body.params.conversation_timeout, 60);
  assert.equal(log[1].body.params.id, log[0].body.params.id);
  assert.match(log[0].body.params.message, /Acme/);
});

test('HTTP 200 JSON-RPC errors, malformed output and HTTP errors never become a receptionist answer', async () => {
  for (const result of [{ error: { code: -32603, message: 'private provider secret' } }, { result: { response: 'not JSON' } }, { result: { response: '{}' } }, null]) {
    const transport = createSignalWireReceptionist({ env, fetcher: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.method === 'delete') return Response.json({ id: body.id, jsonrpc: '2.0', result: { status: 'deleted' } });
      return result ? Response.json({ id: body.id, jsonrpc: '2.0', ...result }) : new Response('private provider secret', { status: 401 });
    } });
    await assert.rejects(transport.generate(input), error => error.status === 503 && !error.message.includes('private'));
  }
});

test('an inquiry is checked and limited before minting a guest, and browser response contains no project credential', async () => {
  let paid = 0;
  const transport = createSignalWireReceptionist({ env, fetcher: async (...args) => { paid++; return provider([])(...args); } });
  for (const store of [{ ...granted, getInquiry: async () => null }, { ...granted, consumeLimits: async () => { throw new HttpError(429, 'Limit reached.'); } }]) {
    const handlers = createReceptionistVoiceHandlers({ signalwire: transport, getStore: () => store, env });
    assert.notEqual((await handlers.session(req('/api/receptionist-session', input))).status, 200);
  }
  const handlers = createReceptionistVoiceHandlers({ signalwire: transport, getStore: () => granted, env });
  assert.equal((await handlers.session(req('/api/receptionist-session', input, { origin: 'https://evil.example.test' }))).status, 403);
  assert.equal(paid, 0);
  const response = await handlers.session(req('/api/receptionist-session', input));
  assert.equal(response.status, 200);
  assert.doesNotMatch(await response.text(), /test-project-secret|test-refresh-secret|test-callback-secret/);
  assert.equal(paid, 1);
});

test('voice callbacks authenticate, bind the call, reject replay and expire before generating; speech is always checked', async () => {
  let time = new Date('2026-10-05T12:00:00Z'), generated = 0;
  const claims = new Map();
  const store = { ...granted, consumeLimits: async rules => {
    for (const rule of rules) if ((claims.get(rule.key) || 0) >= rule.limit) throw new HttpError(429, 'Limit reached.');
    for (const rule of rules) claims.set(rule.key, (claims.get(rule.key) || 0) + 1);
  } };
  const transport = createSignalWireReceptionist({ env, fetcher: provider([]), now: () => time });
  const handlers = createReceptionistVoiceHandlers({ signalwire: { ...transport, generate: async () => { generated++; return output; } }, getStore: () => store, env, now: () => time });
  const access = await (await handlers.session(req('/api/receptionist-session', input))).json();
  assert.equal((await handlers.swml(req('/api/receptionist-swml?mode=voice', { params: { session: access.session } }))).status, 403);
  const response = await handlers.swml(callback(access.session));
  assert.equal(response.status, 200);
  const document = await response.json(), prompt = document.sections.main.find(x => x.prompt).prompt;
  assert.match(prompt.play, /Thank you for calling Acme/);
  assert.doesNotMatch(prompt.play, /appointment is confirmed|email was sent/);
  assert.equal(prompt.say_voice, 'openai.alloy');
  assert.match(document.sections.main[0].user_event.event.receptionist.turn.followUp, /no confirmation has been sent/i);
  assert.equal((await handlers.swml(callback(access.session))).status, 403);
  assert.equal(generated, 1);
  const next = document.sections.main.find(x => x.transfer).transfer.params.session;
  const body = { params: { session: next }, call: { call_id: address, project_id: PROJECT_ID, type: 'webrtc', to: PREVIEW_ALIAS }, vars: { prompt_result: 'match_speech', prompt_value: 'What are your hours?' } };
  assert.equal((await handlers.swml(req('/api/receptionist-swml?mode=voice', body, { authorization: auth }))).status, 403);
  body.call.call_id = callId;
  assert.equal((await handlers.swml(req('/api/receptionist-swml?mode=voice', body, { authorization: auth }))).status, 200, 'the next caller turn validates after appending speech');
  assert.equal(generated, 2);
  time = new Date(time.getTime() + 181000);
  assert.equal((await handlers.swml(callback(next))).status, 403);
  assert.equal(generated, 2);
});

test('definitions contain no legacy recording, SMS, ElevenLabs or ngrok behavior; SWML templates in speech cannot evaluate', () => {
  const turn = groundTurn({ ...output, booking: { status: 'none', slotId: null }, reply: 'Hello ${envs.secret} %{call.from}.', followUp: '' }, input);
  const voice = checkedVoiceDefinition(turn, { callbackUrl: `${origin}/api/receptionist-swml?mode=voice`, session: 'synthetic' });
  const play = voice.sections.main.find(x => x.prompt).prompt.play;
  assert.doesNotMatch(play, /\$\{|%\{/);
  const entry = voiceEntryDefinition(`${origin}/api/receptionist-swml?mode=voice`);
  assert.equal(entry.sections.main[0].answer.max_duration, 180);
  assert.doesNotMatch(JSON.stringify([voice, entry, chatDefinition()]), /elevenlabs|ngrok|record_call|send_sms|post_prompt_url/i);
});

test('a hold requires caller acceptance of an offered time and contact details actually spoken', () => {
  const slot = { id: '20261005T0900', label: 'Monday at nine' };
  const outputWithContact = { ...output, caller: { name: 'Ann', callback: '555-0100', reason: 'Drain' }, booking: { status: 'held', slotId: slot.id } };
  const checked = messages => groundTurn(outputWithContact, { ...input, slots: [slot], messages });
  const offered = { role: 'receptionist', content: 'I can offer Monday at nine. Would you like me to hold it?' };
  assert.equal(checked([offered, { role: 'caller', content: 'What does it cost?' }]).booking.status, 'offered');
  assert.equal(checked([offered, { role: 'caller', content: 'Yes, please hold it.' }]).booking.status, 'offered', 'model-invented contact details cannot authorize a hold');
  assert.equal(checked([offered, { role: 'caller', content: 'Yes, please hold it. I am Ann, 555-0100.' }]).booking.status, 'held');
  assert.equal(checked([offered, { role: 'caller', content: 'Yes, but change it to another time. Ann, 555-0100.' }]).booking.status, 'offered');
});

test('typed replies never request speech and receptionist source has no ElevenLabs or browser recognition path', async () => {
  const response = await createReceptionistHandler({ generate: async () => output, getStore: () => granted })(req('/api/receptionist', { ...input, speak: true }));
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.audio, undefined);
  assert.match(value.voiceError, /browser voice call/);
  for (const file of ['../api/receptionist.js', '../dist/receptionist/receptionist.js', '../dist/receptionist/signalwire-browser.js']) assert.doesNotMatch(await readFile(new URL(file, import.meta.url), 'utf8'), /ElevenLabs|elevenlabs\.io|SpeechRecognition/);
});
