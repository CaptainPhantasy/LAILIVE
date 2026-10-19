import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createFollowupHandler } from '../lib/followups.js';
import { signOwnerToken } from '../lib/owner-documents-core.js';
import { OWNER_ADDRESSES } from '../lib/frontdesk.js';

const env = {
  RECEPTIONIST_SESSION_SECRET: 'test-session-secret-at-least24characters',
  FRONTDESK_PUBLIC_ORIGIN: 'https://legacyai.space',
  FOLLOWUP_SECRET: 'followup-secret',
};
const inquiryId = '11111111-2222-4333-8444-555555555555';
const token = () => signOwnerToken({ id: inquiryId, scope: 'followups', exp: Date.now() + 86400000 }, env.RECEPTIONIST_SESSION_SECRET);
const link = () => `https://legacyai.space/api/frontdesk/followups?token=${encodeURIComponent(token())}`;
const post = (body, secret = 'followup-secret') => new Request('https://legacyai.space/api/frontdesk/followups', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-frontdesk-secret': secret }, body: JSON.stringify(body),
});
const decide = (step, action) => new Request(link(), {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: token(), step, action }),
});
const steps = () => [
  { delay_days: 0, subject: 'Checking in on your inquiry', body: 'Just checking in to see whether you still need help with the water heater. Reply here and we will pick it up.' },
  { delay_days: 3, subject: 'One more note', body: 'If the timing is better later, reply and we will hold a slot. No pressure either way, and thanks for reading.' },
];
async function setup(pg) {
  await pg.query('CREATE TABLE legacy_contacts (id uuid PRIMARY KEY, name text NOT NULL, email text NOT NULL)');
  await pg.query('CREATE TABLE legacy_inquiries (id uuid PRIMARY KEY, contact_id uuid NOT NULL)');
  await pg.query("INSERT INTO legacy_contacts(id,name,email) VALUES ('99999999-8888-4777-8666-555555555555','Pat Inquiry','pat@example.com')");
  await pg.query(`INSERT INTO legacy_inquiries(id,contact_id) VALUES ($1::uuid,'99999999-8888-4777-8666-555555555555')`, [inquiryId]);
}

test('a plan is stored and only the owners are emailed', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createFollowupHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env });
  try {
    await setup(pg);
    assert.equal((await handler(post({ inquiry_id: inquiryId, steps: steps() }, 'wrong'))).status, 401);
    assert.equal((await handler(post({ inquiry_id: '00000000-0000-4000-8000-000000000000', steps: steps() }))).status, 404);
    assert.equal((await handler(post({ inquiry_id: inquiryId, steps: [] }))).status, 400);
    assert.equal((await handler(post({ inquiry_id: inquiryId, steps: [{ delay_days: 99, subject: 'x', body: 'short' }] }))).status, 400);
    const created = await (await handler(post({ inquiry_id: inquiryId, steps: steps() }))).json();
    assert.equal(created.created, 2);
    assert.equal(sent.length, OWNER_ADDRESSES.length);
    assert.ok(!sent.some(message => message.to === 'pat@example.com'));
    const page = await (await handler(new Request(link()))).text();
    assert.match(page, /Step 1/);
    assert.match(page, /Step 2/);
    assert.match(page, /Approve/);
  } finally { await pg.close(); }
});

test('approving and cancelling are one-time decisions', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createFollowupHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env });
  try {
    await setup(pg);
    await handler(post({ inquiry_id: inquiryId, steps: steps() }));
    const rows = (await pg.query('SELECT id FROM legacy_followup_steps ORDER BY step')).rows;
    assert.match(await (await handler(decide(rows[0].id, 'approve'))).text(), /Step approved/);
    assert.match(await (await handler(decide(rows[1].id, 'cancel'))).text(), /Step cancelled/);
    assert.match(await (await handler(decide(rows[0].id, 'approve'))).text(), /already handled/);
    const statuses = (await pg.query('SELECT status FROM legacy_followup_steps ORDER BY step')).rows.map(row => row.status);
    assert.deepEqual(statuses, ['approved', 'cancelled']);
    assert.equal((await pg.query("SELECT count(*)::int AS n FROM legacy_followup_steps WHERE status='approved'")).rows[0].n, 1);
  } finally { await pg.close(); }
});

test('the sender only sends approved steps that are due, once', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createFollowupHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env });
  try {
    await setup(pg);
    await handler(post({ inquiry_id: inquiryId, steps: steps() }));
    const rows = (await pg.query('SELECT id FROM legacy_followup_steps ORDER BY step')).rows;
    await handler(decide(rows[0].id, 'approve'));
    const first = await (await handler(post({ action: 'due' }))).json();
    assert.equal(first.sent, 1);
    assert.equal(sent.filter(message => message.to === 'pat@example.com').length, 1);
    assert.equal(sent.find(message => message.to === 'pat@example.com').subject, 'Checking in on your inquiry');
    assert.equal((await pg.query('SELECT status FROM legacy_followup_steps ORDER BY step')).rows[0].status, 'sent');
    assert.equal((await pg.query('SELECT status FROM legacy_followup_steps ORDER BY step')).rows[1].status, 'draft');
    const second = await (await handler(post({ action: 'due' }))).json();
    assert.equal(second.sent, 0);
    assert.equal(sent.filter(message => message.to === 'pat@example.com').length, 1);
  } finally { await pg.close(); }
});

test('invalid links are refused', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  const handler = createFollowupHandler({ getDb: () => db, mail: async () => true, env });
  try {
    await setup(pg);
    assert.equal((await handler(new Request('https://legacyai.space/api/frontdesk/followups?token=bad'))).status, 401);
    assert.equal((await handler(decide('bad', 'approve'))).status, 400);
    const badToken = new Request(link(), {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: 'bad', step: 'x', action: 'approve' }),
    });
    assert.equal((await handler(badToken)).status, 401);
  } finally { await pg.close(); }
});

test('an approved unsent step can be cancelled and a stale approval cannot reactivate it', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createFollowupHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env });
  try {
    await setup(pg);
    await handler(post({ inquiry_id: inquiryId, steps: [steps()[0]] }));
    const id = (await pg.query('SELECT id FROM legacy_followup_steps')).rows[0].id;
    await handler(decide(id, 'approve'));
    const approvedAt = (await pg.query('SELECT approved_at FROM legacy_followup_steps')).rows[0].approved_at;
    assert(approvedAt);
    assert.match(await (await handler(decide(id, 'cancel'))).text(), /Step cancelled/);
    const cancelled = (await pg.query('SELECT status,approved_at FROM legacy_followup_steps')).rows[0];
    assert.equal(cancelled.status, 'cancelled');
    assert.deepEqual(cancelled.approved_at, approvedAt, 'the original approval history is preserved');
    assert.match(await (await handler(decide(id, 'approve'))).text(), /already handled/);
    assert.equal((await pg.query('SELECT status FROM legacy_followup_steps')).rows[0].status, 'cancelled');
    assert.equal((await (await handler(post({ action: 'due' }))).json()).sent, 0);
    assert.equal(sent.filter(message => message.to === 'pat@example.com').length, 0);
  } finally { await pg.close(); }
});

test('cancellation cannot interrupt a claimed send or change a sent step', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const handler = createFollowupHandler({ getDb: () => db, env, mail: async message => {
    if (message.to === 'pat@example.com') { sent.push(message); enter(); await blocked; }
    return true;
  } });
  let sending;
  try {
    await setup(pg);
    await handler(post({ inquiry_id: inquiryId, steps: [steps()[0]] }));
    const id = (await pg.query('SELECT id FROM legacy_followup_steps')).rows[0].id;
    await handler(decide(id, 'approve'));
    sending = handler(post({ action: 'due' }));
    await entered;
    assert.match(await (await handler(decide(id, 'cancel'))).text(), /already handled/);
    assert.equal((await pg.query('SELECT status FROM legacy_followup_steps')).rows[0].status, 'sending');
    release();
    assert.equal((await (await sending).json()).sent, 1);
    assert.match(await (await handler(decide(id, 'cancel'))).text(), /already handled/);
    assert.match(await (await handler(decide(id, 'approve'))).text(), /already handled/);
    assert.equal((await pg.query('SELECT status FROM legacy_followup_steps')).rows[0].status, 'sent');
    assert.equal(sent.length, 1);
  } finally { release(); if (sending) await sending; await pg.close(); }
});
