import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createOwnerDocumentHandler } from '../lib/owner-documents.js';
import { createOwnerReplyHandler, cleanReplyBody } from '../lib/owner-reply.js';
import { applyOwnerReplyEdit } from '../lib/owner-reply-edit.js';
import { signOwnerToken } from '../lib/owner-documents-core.js';

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
      MessageID: 'original-reply',
      TextBody: 'Change "Line one." to "Line two."\n\nOn Oct 18, 2026, Legacy AI wrote:\n> old text',
    }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.version, 2);

    const updated = (await pg.query('SELECT content,version FROM legacy_owner_documents')).rows[0];
    assert.equal(updated.content, 'Line two.');
    assert.doesNotMatch(updated.content, /old text/);
    assert.equal(updated.version, 2);
    assert.ok(sent.some(message => message.subject === 'Reply applied: Reply test' && /https:\/\/legacyai\.space\/api\/frontdesk\/document\?token=/.test(message.body)));
    assert.equal(sent.at(-1).replyTo, `reply+${row.id}@legacyai.space`);

    const token = signOwnerToken({ id: row.id, scope: 'review', exp: Date.now() + 60000 }, env.RECEPTIONIST_SESSION_SECRET);
    const stale = await docs.document(new Request(`https://legacyai.space/api/frontdesk/document?token=${token}`, {
      method: 'POST', body: new URLSearchParams({ action: 'approve', version: '1', title: 'Reply test', content: 'Line one.' }),
    }));
    assert.equal(stale.status, 409);
    assert.equal(sent.some(message => message.subject === 'Reply test'), false);
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
    assert.equal((await replies(replyRequest({ To: 'reply+00000000-0000-4000-a000-000000000000@legacyai.space', From: 'douglas@legacyai.space', TextBody: 'x', MessageID: 'unknown-document' }))).status, 404);
    assert.equal(sent.length, 0);
  } finally { await pg.close(); }
});

test('quoted reply text is removed before the draft is updated', () => {
  assert.equal(cleanReplyBody('Change the total.\n\nOn Oct 18, 2026, Legacy AI wrote:\n> old'), 'Change the total.');
});

async function draftFixture(content = 'Total: $100\nWork: Inspect drain') {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const docs = createOwnerDocumentHandler({ getDb: () => db, mail: async message => sent.push(message), env });
  await docs.owner(req({ call: { call_id: 'fixture', from: '+18123405761' }, vars: { prompt_value: '123456' } }));
  const id = '11111111-1111-4111-a111-111111111111';
  await pg.query('INSERT INTO legacy_owner_documents(id,call_id,kind,title,content,recipient) VALUES ($1,$2,$3,$4,$5,$6)', [id, 'fixture', 'invoice', 'Test invoice', content, 'customer@example.test']);
  let email = 0;
  const payload = text => ({ To: `Legacy AI <reply+${id}@legacyai.space>`, From: 'Douglas Talley <Douglas@LegacyAI.space>', TextBody: text, MessageID: `fixture-email-${++email}` });
  const row = async () => (await pg.query('SELECT content,version,status FROM legacy_owner_documents WHERE id=$1', [id])).rows[0];
  return { pg, db, docs, id, sent, payload, row };
}

test('specific owner wording edits the unique field and preserves every other fact', async () => {
  const f = await draftFixture();
  try {
    const replies = createOwnerReplyHandler({ getDb: () => f.db, mail: async message => f.sent.push(message), env });
    const response = await replies(replyRequest(f.payload('Please change the total to two dollars.')));
    assert.equal(response.status, 200);
    assert.deepEqual(await f.row(), { content: 'Total: two dollars\nWork: Inspect drain', version: 2, status: 'draft' });
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].to, 'douglas@legacyai.space');
  } finally { await f.pg.close(); }
});

test('unclear, missing, repeated, oversized and unrenderable corrections preserve the draft', async () => {
  const original = 'Total: $100\nWork: Inspect drain\nRepeat Repeat';
  const f = await draftFixture(original);
  try {
    const replies = createOwnerReplyHandler({ getDb: () => f.db, mail: async message => f.sent.push(message), env });
    for (const text of ['Make this more professional', 'Change the address to Indiana', 'Replace "Repeat" with "One"', 'REPLACE: ', 'REPLACE: Unsupported 😀', `REPLACE: ${'x'.repeat(10001)}`]) {
      const response = await replies(replyRequest(f.payload(text)));
      assert.ok([400, 413, 422].includes(response.status), `${text.slice(0, 30)} should be refused`);
      assert.deepEqual(await f.row(), { content: original, version: 1, status: 'draft' });
    }
    assert.equal(f.sent.length, 0);
  } finally { await f.pg.close(); }
});

test('duplicate email events apply once and conflicting reuse is refused', async () => {
  const f = await draftFixture();
  try {
    const replies = createOwnerReplyHandler({ getDb: () => f.db, mail: async message => f.sent.push(message), env });
    const payload = { ...f.payload('Change the total to $125'), MessageID: 'provider-event-one' };
    assert.equal((await replies(replyRequest(payload))).status, 200);
    const repeated = await replies(replyRequest(payload));
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json()).duplicate, true);
    assert.equal((await replies(replyRequest({ ...payload, TextBody: 'Change the total to $900' }))).status, 409);
    assert.equal((await f.row()).content, 'Total: $125\nWork: Inspect drain');
    assert.equal((await f.row()).version, 2);
    assert.equal(f.sent.length, 1);
  } finally { await f.pg.close(); }
});

test('failed review notification can retry without applying the edit twice', async () => {
  const f = await draftFixture(); let attempts = 0;
  try {
    const replies = createOwnerReplyHandler({ getDb: () => f.db, mail: async message => { attempts++; if (attempts === 1) throw new Error('provider unavailable'); f.sent.push(message); }, env });
    const payload = { ...f.payload('Change the total to $125'), MessageID: 'retry-review' };
    const first = await replies(replyRequest(payload));
    assert.equal(first.status, 502);
    assert.equal((await first.json()).applied, true);
    assert.equal((await f.row()).version, 2);
    assert.equal((await replies(replyRequest(payload))).status, 200);
    assert.equal((await f.row()).version, 2);
    assert.equal(attempts, 2);
    assert.equal(f.sent.length, 1);
  } finally { await f.pg.close(); }
});

test('an explicit false mailer result remains pending and retries without another edit', async () => {
  const f = await draftFixture(); let attempts = 0;
  try {
    const replies = createOwnerReplyHandler({ getDb: () => f.db, mail: async message => { attempts++; if (attempts === 1) return false; f.sent.push(message); return true; }, env });
    const payload = { ...f.payload('Change the total to $125'), MessageID: 'rejected-review' };
    const first = await replies(replyRequest(payload));
    assert.equal(first.status, 502);
    assert.equal((await first.json()).reviewEmailed, false);
    assert.equal((await f.pg.query('SELECT notification FROM legacy_owner_reply_receipts')).rows[0].notification, 'pending');
    assert.equal((await f.row()).version, 2);
    const retry = await replies(replyRequest(payload));
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).reviewEmailed, true);
    assert.equal((await f.row()).version, 2);
    assert.equal(attempts, 2);
    assert.equal(f.sent.length, 1);
  } finally { await f.pg.close(); }
});

test('a delayed review-email retry reports an already delivered document without sending an obsolete draft notice', async () => {
  const f = await draftFixture(); let attempts = 0;
  try {
    const replies = createOwnerReplyHandler({ getDb: () => f.db, mail: async () => { attempts++; return false; }, env });
    const payload = { ...f.payload('Change the total to $125'), MessageID: 'approved-before-review-retry' };
    assert.equal((await replies(replyRequest(payload))).status, 502);
    const token = signOwnerToken({ id: f.id, scope: 'review', exp: Date.now() + 60000 }, env.RECEPTIONIST_SESSION_SECRET);
    const approval = await f.docs.document(new Request(`https://legacyai.space/api/frontdesk/document?token=${token}`, {
      method: 'POST', body: new URLSearchParams({ action: 'approve', version: '2', title: 'Test invoice', content: 'Total: $125\nWork: Inspect drain' }),
    }));
    assert.equal(approval.status, 303);
    assert.equal((await f.row()).status, 'sent');
    assert.equal(f.sent.length, 1);
    const repeated = await replies(replyRequest(payload));
    assert.equal(repeated.status, 200);
    const result = await repeated.json();
    assert.equal(result.documentStatus, 'sent');
    assert.equal(result.reviewSkipped, true);
    assert.equal((await f.row()).version, 2);
    assert.equal(attempts, 1);
    assert.equal(f.sent.length, 1);
  } finally { await f.pg.close(); }
});

test('oversized email event IDs are rejected unchanged instead of being truncated', async () => {
  const f = await draftFixture();
  try {
    const replies = createOwnerReplyHandler({ getDb: () => f.db, mail: async message => { f.sent.push(message); return true; }, env });
    const payload = f.payload('Change the total to $125');
    assert.equal((await replies(replyRequest({ ...payload, MessageID: 'a'.repeat(501) }))).status, 413);
    assert.deepEqual(await f.row(), { content: 'Total: $100\nWork: Inspect drain', version: 1, status: 'draft' });
    assert.equal(f.sent.length, 0);
    assert.equal((await replies(replyRequest({ ...payload, MessageID: 'a'.repeat(500) }))).status, 200);
    assert.equal((await f.row()).version, 2);
    assert.equal(f.sent.length, 1);
  } finally { await f.pg.close(); }
});

test('new emails may repeat earlier corrections, but a delayed retry cannot undo a newer revision', async () => {
  const f = await draftFixture();
  try {
    const replies = createOwnerReplyHandler({ getDb: () => f.db, mail: async message => f.sent.push(message), env });
    const first = f.payload('Change the total to $125');
    assert.equal((await replies(replyRequest(first))).status, 200);
    assert.equal((await replies(replyRequest(f.payload('Change the total to $150')))).status, 200);
    assert.equal((await replies(replyRequest(first))).status, 200);
    assert.equal((await f.row()).content, 'Total: $150\nWork: Inspect drain');
    assert.equal((await f.row()).version, 3);
    assert.equal((await replies(replyRequest(f.payload('Change the total to $125')))).status, 200);
    assert.deepEqual(await f.row(), { content: 'Total: $125\nWork: Inspect drain', version: 4, status: 'draft' });
    assert.equal(f.sent.length, 3);
    const retry = await replies(replyRequest(first));
    assert.equal((await retry.json()).duplicate, true);
    assert.equal((await f.row()).version, 4);
    assert.equal(f.sent.length, 3);
  } finally { await f.pg.close(); }
});

test('an email without a stable provider message ID leaves the original draft unchanged', async () => {
  const f = await draftFixture();
  try {
    const replies = createOwnerReplyHandler({ getDb: () => f.db, mail: async message => f.sent.push(message), env });
    const payload = f.payload('Change the total to $125'); delete payload.MessageID;
    assert.equal((await replies(replyRequest(payload))).status, 400);
    assert.equal((await f.row()).version, 1);
    assert.equal(f.sent.length, 0);
  } finally { await f.pg.close(); }
});

test('an acknowledged no-op email cannot later undo a newer correction', async () => {
  const f = await draftFixture();
  try {
    const replies = createOwnerReplyHandler({ getDb: () => f.db, mail: async message => f.sent.push(message), env });
    const original = f.payload('Change the total to $100');
    const noChange = await replies(replyRequest(original));
    assert.equal(noChange.status, 200);
    assert.equal((await noChange.json()).changed, false);
    assert.equal((await f.row()).version, 1);
    assert.equal(f.sent.length, 0);
    assert.equal((await replies(replyRequest(f.payload('Change the total to $125')))).status, 200);
    const repeated = await replies(replyRequest(original));
    assert.equal((await repeated.json()).duplicate, true);
    assert.deepEqual(await f.row(), { content: 'Total: $125\nWork: Inspect drain', version: 2, status: 'draft' });
    assert.equal(f.sent.length, 1);
  } finally { await f.pg.close(); }
});

test('missing protected-link configuration refuses the correction before saving it', async () => {
  const f = await draftFixture();
  try {
    for (const overrides of [{ RECEPTIONIST_SESSION_SECRET: '' }, { FRONTDESK_PUBLIC_ORIGIN: 'http://insecure.example.test' }]) {
      const replies = createOwnerReplyHandler({ getDb: () => f.db, mail: async message => f.sent.push(message), env: { ...env, ...overrides } });
      assert.equal((await replies(replyRequest(f.payload('Change the total to $125')))).status, 503);
      assert.equal((await f.row()).version, 1);
    }
    assert.equal(f.sent.length, 0);
  } finally { await f.pg.close(); }
});

test('an abandoned review-email claim recovers without changing the draft again', async () => {
  const f = await draftFixture(); const clock = Date.now();
  try {
    const replies = createOwnerReplyHandler({ getDb: () => f.db, mail: async message => f.sent.push(message), env, now: () => clock });
    const payload = { ...f.payload('Change the total to $125'), MessageID: 'abandoned-review' };
    assert.equal((await replies(replyRequest(payload))).status, 200);
    await f.pg.query("UPDATE legacy_owner_reply_receipts SET notification='sending',notification_started_at=$1", [new Date(clock).toISOString()]);
    const busy = await replies(replyRequest(payload));
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get('Retry-After'), '60');
    assert.equal(f.sent.length, 1);
    await f.pg.query('UPDATE legacy_owner_reply_receipts SET notification_started_at=$1', [new Date(clock - 300001).toISOString()]);
    assert.equal((await replies(replyRequest(payload))).status, 200);
    assert.equal((await f.row()).version, 2);
    assert.equal(f.sent.length, 2);
  } finally { await f.pg.close(); }
});

test('simultaneous different replies do not overwrite the winning revision', async () => {
  const f = await draftFixture();
  try {
    let reads = 0; let release;
    const barrier = new Promise(resolve => { release = resolve; });
    const wrapped = {
      transaction: callback => f.db.transaction(callback),
      execute: async query => {
        const result = await f.db.execute(query);
        if (/SELECT \* FROM legacy_owner_documents/.test(f.db.dialect.sqlToQuery(query).sql)) {
          reads++; if (reads === 2) release(); await barrier;
        }
        return result;
      },
    };
    const replies = createOwnerReplyHandler({ getDb: () => wrapped, mail: async message => f.sent.push(message), env });
    const results = await Promise.all(['$125', '$150'].map((value, index) => replies(replyRequest({ ...f.payload(`Change the total to ${value}`), MessageID: `concurrent-${index}` }))));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    const row = await f.row();
    assert.ok(['Total: $125\nWork: Inspect drain', 'Total: $150\nWork: Inspect drain'].includes(row.content));
    assert.equal(row.version, 2);
    assert.equal(f.sent.length, 1);
  } finally { await f.pg.close(); }
});

test('a concurrently approved document is preserved instead of edited', async () => {
  const f = await draftFixture();
  try {
    const wrapped = {
      transaction: callback => f.db.transaction(callback),
      execute: async query => {
        const result = await f.db.execute(query);
        if (/SELECT \* FROM legacy_owner_documents/.test(f.db.dialect.sqlToQuery(query).sql)) await f.pg.query("UPDATE legacy_owner_documents SET status='sent' WHERE id=$1", [f.id]);
        return result;
      },
    };
    const replies = createOwnerReplyHandler({ getDb: () => wrapped, mail: async message => f.sent.push(message), env });
    assert.equal((await replies(replyRequest(f.payload('Change the total to $125')))).status, 409);
    assert.deepEqual(await f.row(), { content: 'Total: $100\nWork: Inspect drain', version: 1, status: 'sent' });
    assert.equal((await f.pg.query('SELECT count(*)::int AS count FROM legacy_owner_reply_receipts')).rows[0].count, 0);
    assert.equal(f.sent.length, 0);
  } finally { await f.pg.close(); }
});

test('exact replacements are literal, bounded and leave uncertain targets unchanged', () => {
  assert.equal(applyOwnerReplyEdit('Work: Inspect drain', 'Replace "Inspect drain" with "$& $1 $$"').content, 'Work: $& $1 $$');
  assert.equal(applyOwnerReplyEdit('Apples', 'Change Apples to Oranges').content, 'Oranges');
  assert.equal(applyOwnerReplyEdit('A', 'REPLACE: B').content, 'B');
  assert.equal(applyOwnerReplyEdit('Total: $100\nTotal: $200', 'Change the total to $125').ok, false);
  assert.equal(applyOwnerReplyEdit('A', 'Replace "A" with "A"').changed, false);
  assert.equal(applyOwnerReplyEdit('A'.repeat(10000), 'Replace "A" with "B"').ok, false);
  assert.equal(applyOwnerReplyEdit('X' + 'A'.repeat(9999), 'Replace "X" with "YY"').ok, false);
  assert.equal(applyOwnerReplyEdit('Deliver to Sam by Friday', 'Change Deliver to Sam to Deliver to Sue').ok, false);
  assert.equal(applyOwnerReplyEdit('Deliver to Sam by Friday', 'Change "Deliver to Sam" to "Deliver to Sue"').content, 'Deliver to Sue by Friday');
});
