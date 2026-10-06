import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createNativeReceptionistSession } from '../lib/receptionist-native.js';

// Browser seams and provider responses are synthetic. These checks make no calls.
async function pageHarness(response = Response.json({ token: 'synthetic', expiresAt: 1000, destination: '/private/legacyai-receptionist-preview' })) {
  const elements = Object.fromEntries(['start', 'hang-up', 'status', 'error', 'voice-audio', 'consent'].map(id => [id, { hidden: true, disabled: false, checked: true, textContent: '', handlers: {}, addEventListener(event, fn) { this.handlers[event] = fn; } }]));
  let options, starts = 0, stops = 0;
  const source = (await readFile(new URL('../dist/receptionist/native.js', import.meta.url), 'utf8'))
    .replace(/^import .*startBrowserVoice.*\n/m, '')
    .replace("const { startBrowserVoice } = await import('./signalwire-browser.js');", '');
  vm.runInNewContext(source, {
    document: { getElementById: id => elements[id] }, window: { addEventListener() {} }, AbortController,
    fetch: async () => response.clone(),
    startBrowserVoice: async value => { starts++; options = value; return { stop: async () => { stops++; } }; },
  });
  return { elements, get starts() { return starts; }, get stops() { return stops; }, status: state => options.onStatus(state) };
}

test('another call is available after hangup, provider disconnect and connection failure', async () => {
  for (const end of ['hangup', 'disconnect', 'failure']) {
    const page = await pageHarness(end === 'failure' ? Response.json({ error: 'Unavailable' }, { status: 503 }) : undefined);
    await page.elements.start.handlers.click();
    if (end === 'hangup') page.elements['hang-up'].handlers.click();
    if (end === 'disconnect') page.status('disconnected');
    assert.equal(page.elements.start.disabled, false, end);
    assert.equal(page.elements.consent.disabled, false, end);
    if (end !== 'failure') {
      await page.elements.start.handlers.click();
      assert.equal(page.starts, 2, end);
      page.elements['hang-up'].handlers.click();
    }
  }
});

test('active calls survive the former demo and credential deadlines; hangup still releases the call', async () => {
  let now = 0, hungUp = 0, destroyed = 0;
  const timers = new Map(); let timerId = 0;
  const source = (await readFile(new URL('../dist/receptionist/signalwire-browser.js', import.meta.url), 'utf8'))
    .replace(/^import .*\n/, '').replace('export async function', 'async function');
  const context = { Date: { now: () => now }, setTimeout(fn, delay) { timers.set(++timerId, { at: now + delay, fn }); return timerId; }, clearTimeout(id) { timers.delete(id); } };
  vm.createContext(context); vm.runInContext(source, context);
  const stream = { subscribe: () => ({ unsubscribe() {} }) };
  const call = { hangup: async () => { hungUp++; }, remoteStream$: stream, status$: stream };
  const client = { dial: async () => call, destroy: () => { destroyed++; } };
  const connection = await context.startBrowserVoice({ access: { token: 'synthetic', expiresAt: 120, destination: '/private/legacyai-receptionist-preview' }, audio: {}, onStatus() {}, onError: assert.fail, createClient: () => client });
  now = 181000;
  for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); await timer.fn(); }
  assert.equal(hungUp, 0, 'credential expiry does not end an established call');
  assert.equal(destroyed, 0);
  await connection.stop();
  assert.equal(hungUp, 1); assert.equal(destroyed, 1);
});

test('guest access remains short-lived and restricted without imposing a call deadline', async () => {
  const origin = 'https://preview.example.test'; let body;
  const handler = createNativeReceptionistSession({
    env: { VERCEL_ENV: 'preview', RECEPTIONIST_SIGNALWIRE_ENABLED: 'true', RECEPTIONIST_PREVIEW_ORIGIN: origin, SIGNALWIRE_SPACE_HOST: 'legacyai.signalwire.com', SIGNALWIRE_PROJECT_ID: '2f9ce47f-c556-4cf2-803c-2b1525b35b34', SIGNALWIRE_RECEPTIONIST_ADDRESS_ID: 'ff610195-c5b4-44f8-ae1e-9cf4e0d77e54', SIGNALWIRE_API_TOKEN: 'synthetic' },
    now: () => 1000000,
    fetcher: async (_url, options) => { body = JSON.parse(options.body); return Response.json({ token: 'synthetic-guest' }); },
  });
  const response = await handler(new Request(`${origin}/api/receptionist-session`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ consent: true }) }));
  assert.equal(response.status, 200);
  const access = await response.json();
  assert.equal(access.expiresAt, 1120);
  assert.deepEqual(body.allowed_addresses, ['ff610195-c5b4-44f8-ae1e-9cf4e0d77e54']);
  assert.equal(body.expire_at, 1120);
  assert.equal(access.maxCallSeconds, undefined);
});
