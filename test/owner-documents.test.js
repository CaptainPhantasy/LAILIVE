import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createOwnerDocumentHandler } from '../lib/owner-documents.js';
const salt = '0123456789abcdef0123456789abcdef';
const env = { RECEPTIONIST_WEBHOOK_SECRET: 'test-webhook', RECEPTIONIST_SESSION_SECRET: 'test-session-secret-at-least24characters', FRONTDESK_OWNER_PIN_HASH: `${salt}:${scryptSync('123456', salt, 32).toString('hex')}`, FRONTDESK_PUBLIC_ORIGIN: 'https://legacyai.space' };
const req = (payload, url = 'https://legacyai.space/api/frontdesk/owner', secret = true) => new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(secret ? { 'x-frontdesk-secret': 'test-webhook' } : {}) }, body: JSON.stringify(payload) });
test('PIN owner draft PDF edit and explicit approval use durable records with no automatic customer delivery', async () => {
 const pg = new PGlite(); const db = drizzle(pg); const sent = [];
 const handlers = createOwnerDocumentHandler({ getDb: () => db, env, mail: async value => sent.push(value) });
 try {
  assert.equal((await handlers.owner(req({ call_id: 'call-owner', arguments: { content: 'forged' } }))).status, 401);
  const denied = await (await handlers.owner(req({ call: { call_id: 'call-owner', from: '+19999999999' }, vars: { prompt_value: '123456' } }))).json();
  assert.ok(!JSON.stringify(denied).includes('save_owner_draft'));
  const verified = await (await handlers.owner(req({ call: { call_id: 'call-owner', from: '+18123405761' }, vars: { prompt_value: '123456' } }))).json();
  const tool = verified.sections.main[1].ai.SWAIG.functions[0];
  assert.ok(!JSON.stringify(verified).includes('123456'));
  const draft = { call_id: 'call-owner', arguments: { kind: 'field_report', title: 'Test report', content: 'Inspected the entrance. No damage observed.', recipient: 'customer@example.test' } };
  const saved = await (await handlers.owner(req(draft, tool.web_hook_url, false))).json();
  assert.match(saved.response, /saved/); assert.equal(sent.length, 2);
  assert.ok(sent.every(mail => mail.to !== 'customer@example.test'));
  const link = sent[0].body.match(/https:\/\/legacyai.space\/api\/frontdesk\/document\?token=\S+/)[0];
  assert.equal((await handlers.document(new Request(link))).status, 200);
  const pdf = await handlers.document(new Request(link + '&pdf=1')); assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const edit = new FormData(); edit.set('action', 'edit'); edit.set('content', 'Corrected report.');
  assert.equal((await handlers.document(new Request(link, { method: 'POST', body: edit }))).status, 303);
  const approve = new FormData(); approve.set('action', 'approve');
  assert.equal((await handlers.document(new Request(link, { method: 'POST', body: approve }))).status, 303);
  assert.equal(sent[2].to, 'customer@example.test'); assert.match(sent[2].body, /Corrected report/);
  assert.equal((await handlers.document(new Request(link, { method: 'POST', body: approve }))).status, 409);
  assert.equal(sent.length, 3);
 } finally { await pg.close(); }
});
test('missing configured PIN fails closed', async () => {
 const pg = new PGlite(); const db = drizzle(pg);
 try {
 const h = createOwnerDocumentHandler({ getDb: () => db, env: { ...env, FRONTDESK_OWNER_PIN_HASH: '' }, mail: async () => assert.fail('must not send') });
 const result = await (await h.owner(req({ call: { call_id: 'x', from: '+18123405761' }, vars: { prompt_value: '123456' } }))).json();
 assert.ok(!JSON.stringify(result).includes('save_owner_draft'));
 } finally { await pg.close(); }
});
