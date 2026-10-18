import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createReviewRequestHandler } from '../lib/review-requests.js';
import { createReviewLadder } from '../lib/review-ladder.js';
import { OWNER_ADDRESSES } from '../lib/frontdesk.js';

const env = {
  RECEPTIONIST_SESSION_SECRET: 'test-session-secret-at-least24characters',
  FRONTDESK_PUBLIC_ORIGIN: 'https://legacyai.space',
  REVIEW_SECRET: 'review-secret',
};
const create = body => new Request('https://legacyai.space/api/frontdesk/review', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-frontdesk-secret': 'review-secret' },
  body: JSON.stringify(body),
});
const linkFrom = text => (text.match(/https:\/\/legacyai\.space\/api\/frontdesk\/review\?token=[A-Za-z0-9._-]+/) || [])[0];
const approvalToken = text => new URL(linkFrom(text)).searchParams.get('token');

async function approvedRequest(handler, sent, name = 'Test Customer', job = 'JOB-L') {
  await handler(create({ customer_name: name, customer_email: 'customer@example.com', job_id: job }));
  const token = approvalToken(sent[0].body);
  await handler(new Request(`https://legacyai.space/api/frontdesk/review?token=${encodeURIComponent(token)}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token, action: 'approve' }),
  }));
  return token;
}

test('a stale unanswered request is nudged once and only the owners are emailed', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createReviewRequestHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env });
  const ladder = createReviewLadder({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env });
  try {
    await approvedRequest(handler, sent, 'Stale Customer', 'JOB-STALE');
    await pg.query("UPDATE legacy_review_requests SET updated_at = now() - interval '10 days'");
    const before = sent.length;
    const first = await ladder();
    assert.equal(first.nudged, 1);
    assert.equal(first.pending[0].customer, 'Stale Customer');
    assert.equal(sent.length, before + OWNER_ADDRESSES.length);
    assert.ok(sent.slice(before).every(message => OWNER_ADDRESSES.includes(message.to)));
    assert.match(sent.at(-1).body, /No second customer email was sent/);
    assert.match(sent.at(-1).body, /Approve one second ask: https:\/\/legacyai\.space\/api\/frontdesk\/review\?token=/);
    const second = await ladder();
    assert.equal(second.nudged, 0);
    assert.equal((await pg.query("SELECT count(*)::int AS n FROM legacy_review_events WHERE event='ladder_nudge'")).rows[0].n, 1);
  } finally { await pg.close(); }
});

test('fresh and already-rated requests are never nudged', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createReviewRequestHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env });
  const ladder = createReviewLadder({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env });
  try {
    await approvedRequest(handler, sent, 'Fresh Customer', 'JOB-FRESH');
    assert.equal((await ladder()).nudged, 0);
    await pg.query("UPDATE legacy_review_requests SET updated_at = now() - interval '10 days'");
    await pg.query("UPDATE legacy_review_requests SET status='rated', rating=5");
    assert.equal((await ladder()).nudged, 0);
    assert.equal((await pg.query("SELECT count(*)::int AS n FROM legacy_review_events WHERE event='ladder_nudge'")).rows[0].n, 0);
  } finally { await pg.close(); }
});

test('the ladder is safe on an empty database and creates its own tables', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  const ladder = createReviewLadder({ getDb: () => db, mail: async () => true, env });
  try {
    assert.deepEqual(await ladder(), { nudged: 0, pending: [] });
    assert.equal((await pg.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name='legacy_review_requests'")).rows[0].n, 1);
  } finally { await pg.close(); }
});
