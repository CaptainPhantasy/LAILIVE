import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnerGate, normalize, OWNER_CALLER } from '../lib/owner-gate.js';

const env = { RECEPTIONIST_WEBHOOK_SECRET: 'gate-secret', OWNER_GATE_FALLBACK_URL: 'https://legacyai.space/api/receptionist-swml?mode=voice' };
const auth = () => ({ authorization: `Basic ${Buffer.from('receptionist:gate-secret').toString('base64')}` });
const call = (from, headers = auth()) => new Request('https://legacyai.space/api/owner-swml', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ call: { call_id: 'CA123', from } }),
});

test('the owner cell is recognised in any common format', () => {
  for (const value of ['+18123405761', '8123405761', '18123405761', '+1 (812) 340-5761', '812-340-5761']) {
    assert.equal(normalize(value), OWNER_CALLER, value);
  }
  assert.notEqual(normalize('+18125550100'), OWNER_CALLER);
  assert.notEqual(normalize(''), OWNER_CALLER);
});

test('the owner is asked for a keypad PIN before anything else', async () => {
  const gate = createOwnerGate({ env });
  const response = await gate(call('8123405761'));
  assert.equal(response.status, 200);
  const body = await response.json();
  const [prompt, transfer] = body.sections.main;
  assert.match(prompt.prompt.play, /Enter your PIN, then press pound/);
  assert.equal(prompt.prompt.max_digits, 12);
  assert.equal(prompt.prompt.terminators, '#');
  // No speech parameters: digits only.
  assert.equal(prompt.prompt.speech_timeout, undefined);
  assert.equal(prompt.prompt.speech_language, undefined);
  const dest = new URL(transfer.transfer.dest);
  assert.equal(dest.pathname, '/api/frontdesk/owner');
  assert.equal(dest.username, 'receptionist');
  assert.equal(dest.password, 'gate-secret');
});

test('anyone else is handed to the public flow and never sees a PIN prompt', async () => {
  const gate = createOwnerGate({ env });
  const response = await gate(call('+18125550100'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.sections.main.length, 1);
  assert.equal(body.sections.main[0].transfer.dest, env.OWNER_GATE_FALLBACK_URL);
  assert.doesNotMatch(JSON.stringify(body), /PIN/);
});

test('without a public fallback the gate refuses instead of guessing', async () => {
  const gate = createOwnerGate({ env: { RECEPTIONIST_WEBHOOK_SECRET: 'gate-secret' } });
  assert.equal((await gate(call('+18125550100'))).status, 503);
  // The owner path still works: it does not depend on the fallback.
  assert.equal((await gate(call('+18123405761'))).status, 200);
});

test('a caller without the webhook secret is refused', async () => {
  const gate = createOwnerGate({ env });
  assert.equal((await gate(call('+18123405761', {}))).status, 403);
  assert.equal((await gate(call('+18123405761', { authorization: 'Basic ' + Buffer.from('receptionist:wrong').toString('base64') }))).status, 403);
  assert.equal((await gate(new Request('https://legacyai.space/api/owner-swml', { method: 'GET' }))).status, 405);
});
