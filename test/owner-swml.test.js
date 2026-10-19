import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createOwnerSwml } from '../lib/owner-swml.js';
import { createOwnerDocumentHandler } from '../lib/owner-documents.js';

const salt = '0123456789abcdef0123456789abcdef';
const env = {
  RECEPTIONIST_WEBHOOK_SECRET: 'test-webhook',
  RECEPTIONIST_SESSION_SECRET: 'test-session-secret-at-least24characters',
  FRONTDESK_OWNER_PIN_HASH: `${salt}:${scryptSync('05282014', salt, 32).toString('hex')}`,
  FRONTDESK_PUBLIC_ORIGIN: 'https://legacyai.space',
};
const call = (from = '+18123405761', id = 'call-owner-1') => new Request('https://legacyai.space/api/owner-swml', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-frontdesk-secret': 'test-webhook' },
  body: JSON.stringify({ call: { call_id: id, from } }),
});

test('the owner cell gets a keypad PIN prompt with no speech collection', async () => {
  const handler = createOwnerSwml({ env });
  const body = await (await handler(call())).json();
  const steps = body.sections.main;
  const prompt = steps.find(step => step.prompt).prompt;
  assert.equal(prompt.max_digits, 8);
  assert.equal(prompt.terminators, '#');
  assert.equal(prompt.speech_language, undefined);
  assert.equal(prompt.speech_timeout, undefined);
  const transfer = steps.find(step => step.transfer).transfer;
  assert.match(transfer.dest, /\/api\/frontdesk\/owner\?session=/);
});

test('anyone else is forwarded to the receptionist and never sees a PIN prompt', async () => {
  const handler = createOwnerSwml({ env });
  const body = await (await handler(call('+19999999999', 'call-other'))).json();
  assert.equal(JSON.stringify(body).includes('PIN'), false);
  assert.equal(body.sections.main[0].transfer.dest, 'https://legacyai.space/api/receptionist-swml?mode=voice');
});

test('an unsigned request is refused', async () => {
  const handler = createOwnerSwml({ env });
  const request = new Request('https://legacyai.space/api/owner-swml', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal((await handler(request)).status, 401);
});

test('the signed handoff authorizes the PIN, and a forged token does not', async () => {
  const pg = new PGlite();
  const db = drizzle(pg);
  const swml = createOwnerSwml({ env });
  const documents = createOwnerDocumentHandler({ getDb: () => db, mail: async () => true, env });
  const body = await (await swml(call('+18123405761', 'call-pin-1'))).json();
  const dest = body.sections.main.find(step => step.transfer).transfer.dest;
  const post = (value, url = dest) => new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ call: { call_id: 'call-pin-1', from: '+18123405761' }, vars: { prompt_value: value } }),
  });
  try {
    const accepted = await (await documents.owner(post('05282014'))).json();
    assert.ok(accepted.sections.main.find(step => step.record_call), 'a correct PIN through the handoff must open owner dictation');
    const forged = dest.replace(/session=[^&]+/, 'session=forged.token');
    assert.equal((await documents.owner(post('05282014', forged))).status, 401);
  } finally { await pg.close(); }
});
