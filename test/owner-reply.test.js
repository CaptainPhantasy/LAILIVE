import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createOwnerDocumentHandler } from '../lib/owner-documents.js';
import { createOwnerReplyHandler, cleanReplyBody } from '../lib/owner-reply.js';

const salt = '0123456789abcdef0123456789abcdef';
const env = {
  RECEPTIONIST_WEBHOOK_SECRET: 'test-webhook',
  RECEPTIONIST_SESSION_SECRET: 'test-session-secret-at-least24characters',
  INBOUND_EMAIL_SECRET: 'inbound-secret',
  FRONTDESK_OWNER_PIN_HASH: `${salt}:${scryptSync('123456', salt, 32).toString('hex')}`,
  FRONTDESK_PUBLIC_ORIGIN: 'https://legacyai.space',
};
const req = (payload, url = 'https://legacyai.space/api/frontdesk/owner', secret = true) => new Request(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(secret ? { 'x-frontdesk-secret': env.RECEPTIONIST_WEBHOOK_SECRET } : {}) },
  body: JSON.stringify(payload),
});
const replyRequest = (payload, secret = 'inbound-secret') => new Request('https://legacyai.space/api/frontdesk/reply', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-legacy-inbound-secret': secret },
  body: JSON.stringify(payload),
});

test('an owner email reply updates the draft and emails a fresh review link', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const mail = async message => { sent.push(message); return true; };
  const docs = createOwnerDocumentHandler({ getDb: () => db, mail, env });
  const replies = createOwnerReplyHandler({ getDb: () => db, mail, env });
  try {
    const verified = await (await docs.owner(req({ call: { call_id: 'call-reply', from: '+18123405761' }, vars: { prompt_value: '123456' } }))).json();
    const tool = verified.sections.main.find(step => step.ai).ai.SWAIG.functions[0];
    const draft = { call_id: 'call-reply', arguments: { kind: 'field_report', title: 'Reply test', content: 'Line one.', recipient: 'douglas@legacyai.space' } };
    const saved = await (await docs.owner(req(draft, tool.web_hook_url, false))).json();
    assert.match(saved.response, /saved/);
    const row = (await pg.query('SELECT id,version FROM legacy_owner_documents')).rows[0];

    const response = await replies(replyRequest({
      To: `reply+${row.id}@legacyai.space`,
      From: 'douglas@legacyai.space',
      TextBody: 'Change the total to two dollars.\n\nOn Oct 18, 2026, Legacy AI wrote:\n> old text',
    }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.version, 2);

    const updated = (await pg.query('SELECT content,version FROM legacy_owner_documents')).rows[0];
    assert.match(updated.content, /Line one\./);
    assert.match(updated.content, /Owner edit request/);
    assert.match(updated.content, /Change the total to two dollars\./);
    assert.doesNotMatch(updated.content, /old text/);
    assert.equal(updated.version, 2);
    assert.ok(sent.some(message => message.subject === 'Reply applied: Reply test' && /Review: https:\/\/legacyai\.space\/api\/frontdesk\/document\?token=/.test(message.body)));
  } finally { await pg.close(); }
});

test('reply handler rejects a wrong secret, a non-owner sender, and an unknown document', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const mail = async message => { sent.push(message); return true; };
  const docs = createOwnerDocumentHandler({ getDb: () => db, mail, env });
  const replies = createOwnerReplyHandler({ getDb: () => db, mail, env });
  try {
    await docs.owner(req({ call: { call_id: 'call-reply-2', from: '+18123405761' }, vars: { prompt_value: '123456' } }));
    assert.equal((await replies(replyRequest({ To: 'reply+00000000-0000-4000-a000-000000000000@legacyai.space', From: 'douglas@legacyai.space', TextBody: 'x' }, 'wrong'))).status, 401);
    assert.equal((await replies(replyRequest({ To: 'reply+00000000-0000-4000-a000-000000000000@legacyai.space', From: 'someone@example.test', TextBody: 'x' }))).status, 403);
    assert.equal((await replies(replyRequest({ To: 'reply+00000000-0000-4000-a000-000000000000@legacyai.space', From: 'douglas@legacyai.space', TextBody: 'x' }))).status, 404);
    assert.equal(sent.length, 0);
  } finally { await pg.close(); }
});

test('quoted reply text is removed before the draft is updated', () => {
  assert.equal(cleanReplyBody('Change the total.\n\nOn Oct 18, 2026, Legacy AI wrote:\n> old'), 'Change the total.');
});
