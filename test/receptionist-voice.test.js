import test from 'node:test';
import assert from 'node:assert/strict';
import { createReceptionistSpeech } from '../lib/receptionist-voice.js';
import { createReceptionistHandler } from '../lib/receptionist.js';

const env = { ELEVENLABS_API_KEY: 'server-test-secret', RECEPTIONIST_VOICE_ID: 'selectedVoice123' };
const payload = { profile: { business: 'Acme', hours: '8-5', languages: ['en'] }, slots: [], messages: [], speak: true };
const generated = { reply: 'Your appointment is confirmed and the email was sent.', language: 'en', caller: { name: '', callback: '', reason: '' }, booking: { slotId: 'invented', status: 'held' }, followUp: '', endCall: false };
const store = { getInquiry: async () => ({ consent: [{ purpose: 'inquiry-reply', choice: 'granted' }] }), consumeLimits: async () => {} };
const request = body => new Request('https://example.test/api/receptionist', { method: 'POST', headers: { 'content-type': 'application/json', 'x-legacy-inquiry': '3351ea89-24df-4b67-9364-8d57c538a6be' }, body: JSON.stringify(body) });

test('the receptionist uses the owner-selected voice without another server setting', async () => {
  let requestedUrl;
  const speak = createReceptionistSpeech({
    env: { ELEVENLABS_API_KEY: 'server-test-secret' },
    fetcher: async url => {
      requestedUrl = url;
      return new Response(new Uint8Array([73, 68, 51]), { headers: { 'content-type': 'audio/mpeg' } });
    },
  });
  await speak('Hello. How can I help?', 'en');
  assert.equal(requestedUrl, 'https://api.elevenlabs.io/v1/text-to-speech/5u41aNhyCU6hXOcjPPv0?output_format=mp3_44100_128');
});

test('ElevenLabs receives only the validated reply and selected voice; credentials stay server-side', async () => {
  let sent;
  const generateSpeech = createReceptionistSpeech({ env, fetcher: async (url, options) => {
    sent = { url, options, body: JSON.parse(options.body) };
    return new Response(new Uint8Array([73, 68, 51]), { headers: { 'content-type': 'audio/mpeg' } });
  } });
  const handler = createReceptionistHandler({ generate: async () => generated, getStore: () => store, generateSpeech });
  const response = await handler(request(payload));
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(sent.body.text, value.reply);
  assert.notEqual(sent.body.text, generated.reply);
  assert.match(value.reply, /no appointment held/);
  assert.equal(sent.options.headers['xi-api-key'], env.ELEVENLABS_API_KEY);
  assert.equal(sent.url, 'https://api.elevenlabs.io/v1/text-to-speech/selectedVoice123?output_format=mp3_44100_128');
  assert.equal(sent.body.model_id, 'eleven_multilingual_v2');
  assert.equal(sent.body.language_code, 'en');
  assert.deepEqual(value.audio, { mimeType: 'audio/mpeg', base64: 'SUQz' });
  assert(!JSON.stringify(value).includes(env.ELEVENLABS_API_KEY));
});

test('typing and refused inquiries never spend voice credits', async () => {
  let calls = 0;
  const handler = createReceptionistHandler({ generate: async () => generated, getStore: () => store, generateSpeech: async () => { calls++; } });
  assert.equal((await handler(request({ ...payload, speak: false }))).status, 200);
  const denied = createReceptionistHandler({ generate: async () => { throw new Error('must not generate'); }, getStore: () => ({ getInquiry: async () => null }), generateSpeech: async () => { calls++; } });
  assert.equal((await denied(request(payload))).status, 403);
  assert.equal(calls, 0);
});

test('missing voice settings and provider failures keep safe text, without leaking provider details', async () => {
  for (const generateSpeech of [
    undefined,
    createReceptionistSpeech({ env: {}, fetcher: async () => { throw new Error('must not fetch'); } }),
    createReceptionistSpeech({ env, fetcher: async () => new Response('private account details', { status: 401 }) }),
    createReceptionistSpeech({ env, fetcher: async () => new Response('wrong content', { headers: { 'content-type': 'text/html' } }) }),
    createReceptionistSpeech({ env, fetcher: async () => new Response('', { headers: { 'content-type': 'audio/mpeg' } }) }),
    createReceptionistSpeech({ env, fetcher: async () => { throw new Error('timeout with private details'); } }),
  ]) {
    const handler = createReceptionistHandler({ generate: async () => generated, getStore: () => store, generateSpeech });
    const response = await handler(request(payload));
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.match(value.reply, /no appointment held/);
    assert.match(value.voiceError, /ElevenLabs voice is unavailable/);
    assert.equal(value.audio, undefined);
    assert.doesNotMatch(JSON.stringify(value), /private|server-test-secret/);
  }
});
