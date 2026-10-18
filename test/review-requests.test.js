import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createReviewRequestHandler } from '../lib/review-requests.js';
import { OWNER_ADDRESSES } from '../lib/frontdesk.js';

const env = {
  RECEPTIONIST_SESSION_SECRET: 'test-session-secret-at-least24characters',
  FRONTDESK_PUBLIC_ORIGIN: 'https://legacyai.space',
  REVIEW_SECRET: 'review-secret',
};
const create = (body, secret = 'review-secret') => new Request('https://legacyai.space/api/frontdesk/review', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-frontdesk-secret': secret },
  body: JSON.stringify(body),
});
const linkFrom = text => (text.match(/https:\/\/legacyai\.space\/api\/frontdesk\/review\?token=[A-Za-z0-9._-]+/) || [])[0];
const form = (token, fields) => new Request(`https://legacyai.space/api/frontdesk/review?token=${encodeURIComponent(token)}`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ token, ...fields }),
});
const tokenOf = url => new URL(url).searchParams.get('token');

test('a review request emails only the owners until it is approved, then emails the customer once', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createReviewRequestHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env });
  try {
    assert.equal((await handler(create({ customer_name: 'Test Customer', customer_email: 'customer@example.com', job_id: 'JOB-1' }, 'wrong'))).status, 401);
    const created = await (await handler(create({ customer_name: 'Test Customer', customer_email: 'customer@example.com', job_id: 'JOB-1' }))).json();
    assert.equal(created.status, 'draft');
    assert.equal(sent.length, OWNER_ADDRESSES.length);
    assert.ok(sent.every(message => message.to !== 'customer@example.com'));
    const approval = tokenOf(linkFrom(sent[0].body));
    assert.ok(approval);
    assert.match(await (await handler(new Request(`https://legacyai.space/api/frontdesk/review?token=${encodeURIComponent(approval)}`))).text(), /Approve and email the customer/);
    assert.equal(sent.length, OWNER_ADDRESSES.length);
    const approved = await handler(form(approval, { action: 'approve' }));
    assert.equal(approved.status, 200);
    assert.match(await approved.text(), /The review request was emailed/);
    assert.equal(sent.length, OWNER_ADDRESSES.length + 1);
    assert.equal(sent.at(-1).to, 'customer@example.com');
    assert.match(sent.at(-1).subject, /How did we do/);
    assert.match(sent.at(-1).body, /One tap tells us how the visit went/);
    const again = await handler(form(approval, { action: 'approve' }));
    assert.match(await again.text(), /already approved/);
    assert.equal(sent.length, OWNER_ADDRESSES.length + 1);
    assert.equal((await pg.query('SELECT status FROM legacy_review_requests')).rows[0].status, 'approved');
  } finally { await pg.close(); }
});

test('a high rating is saved, offered a configured public link, and cannot be answered twice', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createReviewRequestHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env: { ...env, GOOGLE_REVIEW_URL: 'https://g.page/r/legacy-ai/review' } });
  try {
    await handler(create({ customer_name: 'Happy Customer', customer_email: 'happy@example.com', job_id: 'JOB-2' }));
    const approval = tokenOf(linkFrom(sent[0].body));
    await handler(form(approval, { action: 'approve' }));
    const requestLink = tokenOf(linkFrom(sent.at(-1).body));
    const opened = await handler(new Request(`https://legacyai.space/api/frontdesk/review?token=${encodeURIComponent(requestLink)}`));
    assert.match(await opened.text(), /How did we do/);
    const rated = await handler(form(requestLink, { action: 'rate', rating: '5' }));
    const html = await rated.text();
    assert.match(html, /Leave a public review/);
    assert.match(html, /https:\/\/g\.page\/r\/legacy-ai\/review/);
    assert.equal((await pg.query('SELECT status,rating FROM legacy_review_requests')).rows[0].status, 'rated');
    assert.equal((await pg.query('SELECT rating FROM legacy_review_requests')).rows[0].rating, 5);
    assert.match(await (await handler(form(requestLink, { action: 'rate', rating: '4' }))).text(), /already answered/);
    assert.equal(sent.filter(message => message.to === 'happy@example.com').length, 1);
  } finally { await pg.close(); }
});

test('a low rating opens a private note that is stored and sent only to the owners', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createReviewRequestHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env });
  try {
    await handler(create({ customer_name: 'Unhappy Customer', customer_email: 'unhappy@example.com', job_id: 'JOB-3' }));
    const approval = tokenOf(linkFrom(sent[0].body));
    await handler(form(approval, { action: 'approve' }));
    const requestLink = tokenOf(linkFrom(sent.at(-1).body));
    const rated = await handler(form(requestLink, { action: 'rate', rating: '2' }));
    assert.match(await rated.text(), /Tell us what went wrong/);
    assert.equal((await pg.query('SELECT status FROM legacy_review_requests')).rows[0].status, 'needs_feedback');
    const before = sent.length;
    const note = await handler(form(requestLink, { action: 'feedback', feedback: 'The technician arrived late and did not call.' }));
    assert.match(await note.text(), /went straight to the owner/);
    assert.equal(sent.length, before + OWNER_ADDRESSES.length);
    assert.ok(sent.slice(before).every(message => OWNER_ADDRESSES.includes(message.to)));
    assert.match(sent.at(-1).body, /The technician arrived late/);
    assert.equal((await pg.query("SELECT status,feedback FROM legacy_review_requests")).rows[0].status, 'feedback');
  } finally { await pg.close(); }
});

test('invalid and missing tokens are refused and nothing is created', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createReviewRequestHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env });
  try {
    assert.equal((await handler(new Request('https://legacyai.space/api/frontdesk/review?token=bad'))).status, 401);
    assert.equal((await handler(form('bad', { action: 'rate', rating: '5' }))).status, 401);
    assert.equal((await handler(create({ customer_name: 'X', customer_email: 'not-an-email', job_id: 'J' }))).status, 400);
    assert.equal(sent.length, 0);
  } finally { await pg.close(); }
});
