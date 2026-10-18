import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createOwnerDocumentHandler } from '../lib/owner-documents.js';
import { OWNER_ADDRESSES } from '../lib/frontdesk.js';
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
  assert.ok(verified.sections.main.find(step=>step.record_call));
  const tool = verified.sections.main.find(step=>step.ai).ai.SWAIG.functions[0];
  assert.ok(!JSON.stringify(verified).includes('123456'));
  const draft = { call_id: 'call-owner', arguments: { kind: 'field_report', title: 'Test report', content: 'Inspected the entrance. No damage observed.', recipient: 'customer@example.test' } };
  const saved = await (await handlers.owner(req(draft, tool.web_hook_url, false))).json();
  assert.match(saved.response, /saved/); assert.equal(sent.length, 2);
  assert.ok(sent.every(mail => mail.to !== 'customer@example.test'));
  const link = sent[0].body.match(/https:\/\/legacyai.space\/api\/frontdesk\/document\?token=\S+/)[0];
  assert.equal((await handlers.document(new Request(link))).status, 200);
  const pdf = await handlers.document(new Request(link + '&pdf=1')); assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const edit = new FormData(); edit.set('action', 'edit'); edit.set('version', '1'); edit.set('title', 'Test report'); edit.set('content', 'Corrected report.');
  assert.equal((await handlers.document(new Request(link, { method: 'POST', body: edit }))).status, 303);
  const unsaved = new FormData(); unsaved.set('action', 'approve'); unsaved.set('version', '2'); unsaved.set('title', 'Test report'); unsaved.set('content', 'Unsaved edits');
  assert.equal((await handlers.document(new Request(link, { method: 'POST', body: unsaved }))).status, 409);
  const stale = new FormData(); stale.set('action', 'approve'); stale.set('version', '1'); stale.set('title', 'Test report'); stale.set('content', 'Inspected the entrance. No damage observed.');
  assert.equal((await handlers.document(new Request(link, { method: 'POST', body: stale }))).status, 409);
  const approve = new FormData(); approve.set('action', 'approve'); approve.set('version', '2'); approve.set('title', 'Test report'); approve.set('content', 'Corrected report.');
  assert.equal((await handlers.document(new Request(link, { method: 'POST', body: approve }))).status, 303);
  assert.equal(sent[2].to, 'customer@example.test'); assert.match(sent[2].body, /Corrected report/);
  assert.equal((await handlers.document(new Request(link, { method: 'POST', body: approve }))).status, 409);
  assert.equal(sent.length, 3);
 } finally { await pg.close(); }
});

test('a saved Board question generates an analysis, PDF, and owner email from the review page', async () => {
 const pg = new PGlite(); const db = drizzle(pg); const sent = [];
 const question = 'Should I raise my diagnostic fee from $89 to $109?';
 const handlers = createOwnerDocumentHandler({
  getDb: () => db, env, mail: async value => sent.push(value),
  generateBoard: async value => { assert.equal(value, question); return 'Recommendation: raise the fee to $109.\nDissent: keep $89 for repeat customers.\nRisks: price-sensitive callers.'; },
 });
 try {
  const verified = await (await handlers.owner(req({ call: { call_id: 'call-board', from: '+18123405761' }, vars: { prompt_value: '123456' } }))).json();
  const tool = verified.sections.main.find(step=>step.ai).ai.SWAIG.functions[0];
  const draft = { call_id: 'call-board', arguments: { kind: 'board_request', title: 'Diagnostic fee decision', content: question } };
  const saved = await (await handlers.owner(req(draft, tool.web_hook_url, false))).json();
  assert.match(saved.response, /saved/);
  const link = sent[0].body.match(/https:\/\/legacyai\.space\/api\/frontdesk\/document\?token=\S+/)[0];
  assert.match(sent[0].body, /Generate Board analysis/);
  const generate = new FormData(); generate.set('action', 'board'); generate.set('version', '1');
  assert.equal((await handlers.document(new Request(link, { method: 'POST', body: generate }))).status, 303);
  const row = (await pg.query('SELECT content,version FROM legacy_owner_documents')).rows[0];
  assert.equal(row.version, 2);
  assert.match(row.content, /Board analysis:/);
  assert.match(row.content, /Recommendation: raise the fee to \$109/);
  const pdf = await handlers.document(new Request(link + '&pdf=1'));
  assert.equal(pdf.status, 200); assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const memos = sent.filter(mail => mail.subject === 'Board memo: Diagnostic fee decision');
  assert.equal(memos.length, OWNER_ADDRESSES.length);
  assert.ok(memos.every(mail => /Board analysis:/.test(mail.body) && /Download PDF/.test(mail.body)));
  const again = new FormData(); again.set('action', 'board'); again.set('version', '1');
  assert.equal((await handlers.document(new Request(link, { method: 'POST', body: again }))).status, 409);
 } finally { await pg.close(); }
});

test('failed owner review emails retry for the existing draft and PDF validation leaves it editable', async () => {
 const pg = new PGlite(); const db = drizzle(pg); const attempts = [];
 const handlers = createOwnerDocumentHandler({ getDb: () => db, env, mail: async value => { attempts.push(value); if (attempts.length <= 2) throw new Error('mail unavailable'); } });
 try {
  const verified = await (await handlers.owner(req({ call: { call_id: 'call-review', from: '+18123405761' }, vars: { prompt_value: '123456' } }))).json();
  const tool = verified.sections.main.find(step=>step.ai).ai.SWAIG.functions[0];
  const badTitle = { call_id: 'call-review', arguments: { kind: 'quote', title: '“PDF title”', content: 'Price pending', recipient: 'customer@example.test' } };
  assert.equal((await handlers.owner(req(badTitle, tool.web_hook_url, false))).status, 400);
  const draft = { call_id: 'call-review', arguments: { kind: 'quote', title: 'PDF title', content: 'Price: “pending”', recipient: 'customer@example.test' } };
  const first = await (await handlers.owner(req(draft, tool.web_hook_url, false))).json();
  assert.match(first.response, /email is incomplete/);
  const retry = await (await handlers.owner(req(draft, tool.web_hook_url, false))).json();
  assert.match(retry.response, /review link was emailed/);
  assert.deepEqual(attempts.map(email => email.to), [...OWNER_ADDRESSES, ...OWNER_ADDRESSES]);
  assert.equal((await pg.query('SELECT count(*)::int AS n FROM legacy_owner_documents')).rows[0].n, 1);
  const link = attempts[2].body.match(/https:\/\/legacyai\.space\/api\/frontdesk\/document\?token=\S+/)[0];
  const row = (await pg.query('SELECT title,content FROM legacy_owner_documents')).rows[0];
  assert.equal(row.content, 'Price: “pending”');
  const pdf = await handlers.document(new Request(link + '&pdf=1'));
  assert.equal(pdf.status, 400); assert.match((await pdf.json()).error, /Edit the draft/);
  const approve = new FormData(); approve.set('action', 'approve'); approve.set('version', '1'); approve.set('title', 'PDF title'); approve.set('content', 'Price: “pending”');
  assert.equal((await handlers.document(new Request(link, { method: 'POST', body: approve }))).status, 400);
  assert.equal((await pg.query('SELECT status FROM legacy_owner_documents')).rows[0].status, 'draft');
  const edit = new FormData(); edit.set('action', 'edit'); edit.set('version', '1'); edit.set('title', 'PDF title'); edit.set('content', 'Price pending');
  assert.equal((await handlers.document(new Request(link, { method: 'POST', body: edit }))).status, 303);
  assert.equal((await handlers.document(new Request(link + '&pdf=1'))).status, 200);
 } finally { await pg.close(); }
});
test('multiline drafts approve across CRLF and LF line endings while unsaved edits still conflict', async () => {
 const pg = new PGlite(); const db = drizzle(pg); const sent = [];
 const handlers = createOwnerDocumentHandler({ getDb: () => db, env, mail: async value => sent.push(value) });
 try {
  const verified = await (await handlers.owner(req({ call: { call_id: 'call-crlf', from: '+18123405761' }, vars: { prompt_value: '123456' } }))).json();
  const tool = verified.sections.main.find(step=>step.ai).ai.SWAIG.functions[0];
  const draft = { call_id: 'call-crlf', arguments: { kind: 'field_report', title: 'Multiline report', content: 'Line one.\nLine two.', recipient: 'customer@example.test' } };
  const saved = await (await handlers.owner(req(draft, tool.web_hook_url, false))).json();
  assert.match(saved.response, /review link was emailed/);
  const link = sent[0].body.match(/https:\/\/legacyai\.space\/api\/frontdesk\/document\?token=\S+/)[0];
  const unsaved = new FormData(); unsaved.set('action', 'approve'); unsaved.set('version', '1'); unsaved.set('title', 'Multiline report'); unsaved.set('content', 'Line one.\r\nUnsaved wording.');
  assert.equal((await handlers.document(new Request(link, { method: 'POST', body: unsaved }))).status, 409);
  const edit = new FormData(); edit.set('action', 'edit'); edit.set('version', '1'); edit.set('title', 'Multiline report'); edit.set('content', 'Line one.\r\nLine three.');
  assert.equal((await handlers.document(new Request(link, { method: 'POST', body: edit }))).status, 303);
  assert.equal((await pg.query('SELECT content FROM legacy_owner_documents')).rows[0].content, 'Line one.\nLine three.');
  const stale = new FormData(); stale.set('action', 'approve'); stale.set('version', '1'); stale.set('title', 'Multiline report'); stale.set('content', 'Line one.\r\nLine three.');
  assert.equal((await handlers.document(new Request(link, { method: 'POST', body: stale }))).status, 409);
  const approve = new FormData(); approve.set('action', 'approve'); approve.set('version', '2'); approve.set('title', 'Multiline report'); approve.set('content', 'Line one.\r\nLine three.');
  assert.equal((await handlers.document(new Request(link, { method: 'POST', body: approve }))).status, 303);
  assert.equal(sent[2].to, 'customer@example.test'); assert.ok(sent[2].body.includes('Line one.\nLine three.'));
 } finally { await pg.close(); }
});

test('concurrent identical owner drafts notify each owner address exactly once', async () => {
 const pg = new PGlite(); const db = drizzle(pg); const sent = [];
 const handlers = createOwnerDocumentHandler({ getDb: () => db, env, mail: async value => sent.push(value) });
 try {
  const verified = await (await handlers.owner(req({ call: { call_id: 'call-race', from: '+18123405761' }, vars: { prompt_value: '123456' } }))).json();
  const tool = verified.sections.main.find(step=>step.ai).ai.SWAIG.functions[0];
  const draft = { call_id: 'call-race', arguments: { kind: 'quote', title: 'Race report', content: 'Concurrent save.', recipient: 'customer@example.test' } };
  const responses = await Promise.all([handlers.owner(req(draft, tool.web_hook_url, false)), handlers.owner(req(draft, tool.web_hook_url, false))]);
  assert.ok(responses.every(response => response.status === 200));
  assert.deepEqual(sent.map(mail => mail.to).sort(), [...OWNER_ADDRESSES].sort());
  assert.equal(new Set(sent.map(mail => mail.to)).size, sent.length);
  assert.equal((await pg.query('SELECT count(*)::int AS n FROM legacy_owner_documents')).rows[0].n, 1);
  assert.deepEqual([...(await pg.query('SELECT notified_to FROM legacy_owner_documents')).rows[0].notified_to].sort(), [...OWNER_ADDRESSES].sort());
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

test('owner PIN setup requires owner sign-in and stores only a salted hash', async () => {
 const {createOwnerPinHandler,ownerPinHash}=await import('../lib/owner-pin.js');
 const {verifyOwnerPin}=await import('../lib/owner-documents-core.js');
 const pg=new PGlite();const db=drizzle(pg);
 try {
  const handler=createOwnerPinHandler({getDb:()=>db,authorize:async r=>{if(r.headers.get('authorization')!=='Bearer owner'){const e=new Error();e.status=401;throw e;}}});
  const req=(authorization,pin='619247',confirm=pin)=>new Request('https://example.com/api/owner/pin',{method:'POST',headers:{authorization},body:JSON.stringify({pin,confirm})});
  assert.equal((await handler(req(''))).status,401);
  assert.equal((await handler(req('Bearer owner','619247','999999'))).status,400);
  assert.equal((await handler(req('Bearer owner'))).status,200);
  const stored=await ownerPinHash(db);assert.ok(!stored.includes('619247'));assert.ok(verifyOwnerPin('619247',stored));assert.equal(verifyOwnerPin('999999',stored),false);
 }finally{await pg.close();}
});

test('one-time PIN setup expires, rejects wrong setup key and cannot overwrite an existing PIN', async()=>{
 const {createHash}=await import('node:crypto');
 const {createOwnerPinHandler}=await import('../lib/owner-pin.js');
 const pg=new PGlite();const db=drizzle(pg);
 const env={FRONTDESK_PIN_SETUP_HASH:createHash('sha256').update('test-only-setup').digest('hex'),FRONTDESK_PIN_SETUP_EXPIRES:String(Date.now()+60000)};
 const handler=createOwnerPinHandler({getDb:()=>db,env,authorize:async()=>{const e=new Error();e.status=401;throw e;}});
 const req=key=>new Request('https://example.com/api/owner/pin',{method:'POST',headers:{'x-owner-pin-setup':key},body:JSON.stringify({pin:'619247',confirm:'619247'})});
 try{assert.equal((await handler(req('wrong'))).status,401);assert.equal((await handler(req('test-only-setup'))).status,200);assert.equal((await handler(req('test-only-setup'))).status,409);env.FRONTDESK_PIN_SETUP_EXPIRES='1';assert.equal((await handler(req('test-only-setup'))).status,401);}finally{await pg.close();}
});

test('a correct PIN survives spacing, clears the failure count, and only wrong tries lock the call', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  const handlers = createOwnerDocumentHandler({ getDb: () => db, env, mail: async () => true });
  const pin = (callId, value) => req({ call: { call_id: callId, from: '+18123405761' }, vars: { prompt_value: value } });
  try {
    // Digits relayed with spaces still verify.
    const spaced = await (await handlers.owner(pin('call-spaced', '1 2 3 4 5 6'))).json();
    assert.ok(spaced.sections.main.find(step => step.record_call));
    const rows = (await pg.query('SELECT count(*)::int AS count FROM legacy_owner_pin_attempts')).rows[0];
    assert.equal(rows.count, 0);

    // Two wrong tries accrue, the correct one still works, and the row is cleared.
    for (const value of ['000000', '111111']) await handlers.owner(pin('call-tries', value));
    const afterTwo = (await pg.query("SELECT attempts FROM legacy_owner_pin_attempts WHERE call_id='call-tries'")).rows[0];
    assert.equal(afterTwo.attempts, 2);
    const correct = await (await handlers.owner(pin('call-tries', '123456'))).json();
    assert.ok(correct.sections.main.find(step => step.record_call));
    const cleared = (await pg.query("SELECT count(*)::int AS count FROM legacy_owner_pin_attempts WHERE call_id='call-tries'")).rows[0];
    assert.equal(cleared.count, 0);

    // Three wrong tries end that call; a fourth try is refused with the lockout message.
    for (const value of ['000000', '111111', '999999']) await handlers.owner(pin('call-lock', value));
    const locked = await (await handlers.owner(pin('call-lock', '123456'))).json();
    assert.match(JSON.stringify(locked), /Too many PIN attempts/);
  } finally { await pg.close(); }
});
