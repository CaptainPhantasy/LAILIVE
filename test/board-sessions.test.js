import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createStore } from '../lib/concierge/store.js';
import { consent } from '../lib/concierge/contracts.js';
import { withBoardLead } from '../lib/board-lead.js';

async function fixture(t) {
  const pg = new PGlite(); t.after(() => pg.close());
  await pg.exec(await readFile(new URL('../migrations/0000_legacy_crm.sql', import.meta.url), 'utf8'));
  const db = drizzle(pg), store = createStore(db);
  const inquiry = await store.saveInquiry({ name: 'Visitor', email: 'visitor@example.test', company: '', message: 'Should I hire a technician?', serviceIds: [], approval: { confirmed: true, consentVersion: consent.version, marketingOptIn: false } }, randomUUID());
  const now = () => Date.parse('2026-10-19T12:00:00Z');
  const req = repeatSession => new Request('https://example.test/api/board', { method: 'POST', headers: { 'x-legacy-inquiry': inquiry.id }, body: JSON.stringify({ question: 'Should I hire a technician?', repeatSession }) });
  const wrap = (handler, env = {}) => withBoardLead(handler, () => createStore(db), { env, now });
  return { pg, store, inquiry, now, req, wrap };
}

test('a completed Board session is remembered across instances and ignores the client repeat flag', async t => {
  const f = await fixture(t); let generations = 0;
  const handler = () => { generations++; return new Response('Completed report'); };
  assert.equal(await (await f.wrap(handler)(f.req(false))).text(), 'Completed report');
  for (const repeat of [false, true, undefined]) {
    const response = await f.wrap(handler)(f.req(repeat));
    assert.equal(response.status, 403);
  }
  assert.equal(generations, 1);
  assert.equal(await (await f.wrap(handler, { BOARD_REPEAT_SESSIONS: 'true' })(f.req(false))).text(), 'Completed report');
});

test('overlapping Board requests cannot both claim the first session', async t => {
  const f = await fixture(t);
  let close;
  const response = await f.wrap(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('Report')); close = () => controller.close(); } })))(f.req(false));
  const overlap = await f.wrap(() => assert.fail('A second generation must not start'))(f.req(false));
  assert.equal(overlap.status, 409);
  close();
  assert.equal(await response.text(), 'Report');
  assert.equal((await f.wrap(() => assert.fail('Completed first session cannot be repeated'))(f.req(false))).status, 403);
});

test('failed and cancelled reports release the first session for a retry', async t => {
  const f = await fixture(t);
  assert.equal((await f.wrap(() => Response.json({ error: 'provider failed' }, { status: 502 }))(f.req(false))).status, 502);
  const failed = await f.wrap(() => new Response(new ReadableStream({ start(controller) { controller.error(new Error('stream failed')); } })))(f.req(false));
  await assert.rejects(failed.text(), /stream failed/);
  const cancelled = await f.wrap(() => new Response(new ReadableStream()))(f.req(false));
  await cancelled.body.cancel();
  assert.equal(await (await f.wrap(() => new Response('Recovered report'))(f.req(false))).text(), 'Recovered report');
});

test('an expired session claim is recoverable and an older claim cannot complete its replacement', async t => {
  const f = await fixture(t), time = f.now();
  const old = await f.store.claimBoardSession(f.inquiry.id, false, time);
  await assert.rejects(f.store.claimBoardSession(f.inquiry.id, false, time + 1000), error => error.status === 409);
  const replacement = await f.store.claimBoardSession(f.inquiry.id, false, time + 120001);
  await f.store.finishBoardSession(f.inquiry.id, old, true);
  await f.store.finishBoardSession(f.inquiry.id, replacement, false);
  const retry = await f.store.claimBoardSession(f.inquiry.id, false, time + 120002);
  await f.store.finishBoardSession(f.inquiry.id, retry, true);
  await assert.rejects(f.store.claimBoardSession(f.inquiry.id, false, time + 120003), error => error.status === 403);
});

test('cancelling while a read waits never records a completed session', async t => {
  const f = await fixture(t);
  const response = await f.wrap(() => new Response(new ReadableStream()))(f.req(false));
  const reader = response.body.getReader(), read = reader.read();
  await reader.cancel();
  await read;
  const row = (await f.pg.query('SELECT completed,claim_id FROM legacy_board_sessions')).rows[0];
  assert.equal(row.completed, 0);
  assert.equal(row.claim_id, null);
});
