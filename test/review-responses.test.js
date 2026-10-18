import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createReviewResponseHandler } from '../lib/review-responses.js';
import { OWNER_ADDRESSES } from '../lib/frontdesk.js';

const env = {
  RECEPTIONIST_SESSION_SECRET: 'test-session-secret-at-least24characters',
  FRONTDESK_PUBLIC_ORIGIN: 'https://legacyai.space',
  REVIEW_SECRET: 'review-secret',
};
const create = (body, secret = 'review-secret') => new Request('https://legacyai.space/api/frontdesk/review-response', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-frontdesk-secret': secret },
  body: JSON.stringify(body),
});
const linkFrom = text => (text.match(/https:\/\/legacyai\.space\/api\/frontdesk\/review-response\?token=[A-Za-z0-9._-]+/) || [])[0];
const tokenOf = url => new URL(url).searchParams.get('token');
const save = (token, version, action, reply) => new Request(`https://legacyai.space/api/frontdesk/review-response?token=${encodeURIComponent(token)}`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ token, version: String(version), action, reply }),
});
const generator = async ({ reviewer }) => `Thank you, ${reviewer}. We are glad the visit went well and will share your note with the team.\n\nDouglas, Legacy AI`;

test('a review is stored with a draft reply and only the owners are emailed', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createReviewResponseHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env, generateResponse: generator });
  try {
    assert.equal((await handler(create({ reviewer: 'Pat', rating: 5, review: 'Fast and tidy.' }, 'wrong'))).status, 401);
    const created = await (await handler(create({ reviewer: 'Pat', rating: 5, review: 'Fast and tidy.' }))).json();
    assert.equal(created.status, 'draft');
    assert.equal(created.generated, true);
    assert.equal(sent.length, OWNER_ADDRESSES.length);
    assert.ok(sent.every(message => OWNER_ADDRESSES.includes(message.to)));
    assert.match(sent[0].body, /Draft reply:/);
    const row = (await pg.query('SELECT status,reply,version FROM legacy_review_responses')).rows[0];
    assert.equal(row.status, 'draft');
    assert.match(row.reply, /Thank you, Pat/);
    assert.equal(row.version, 1);
  } finally { await pg.close(); }
});

test('a failed generator still stores the review for the owner to write', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createReviewResponseHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env, generateResponse: async () => { throw new Error('provider down'); } });
  try {
    const created = await (await handler(create({ reviewer: 'Sam', rating: 2, review: 'Late arrival.' }))).json();
    assert.equal(created.generated, false);
    assert.equal((await pg.query('SELECT reply FROM legacy_review_responses')).rows[0].reply, '');
    assert.match(sent[0].body, /No draft was generated/);
  } finally { await pg.close(); }
});

test('the owner can edit, save, and approve once, and nothing is posted', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createReviewResponseHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env, generateResponse: generator });
  try {
    await handler(create({ reviewer: 'Lee', rating: 4, review: 'Good work, a little late.' }));
    const token = tokenOf(linkFrom(sent[0].body));
    const opened = await handler(new Request(`https://legacyai.space/api/frontdesk/review-response?token=${encodeURIComponent(token)}`));
    assert.match(await opened.text(), /Approve reply/);
    assert.match(await (await handler(save(token, 1, 'save', 'Thanks Lee — noted on timing, and glad the work was right.'))).text(), /Saved/);
    assert.equal((await handler(save(token, 1, 'approve', 'stale'))).status, 409);
    const approved = await handler(save(token, 2, 'approve', 'Thanks Lee — noted on timing, and glad the work was right.'));
    const html = await approved.text();
    assert.match(html, /Approved reply/);
    assert.match(html, /Nothing was posted by Legacy AI/);
    const before = sent.length;
    await handler(save(token, 3, 'approve', 'second try'));
    assert.equal(sent.length, before);
    const row = (await pg.query('SELECT status,reply FROM legacy_review_responses')).rows[0];
    assert.equal(row.status, 'approved');
    assert.match(row.reply, /noted on timing/);
    assert.equal(sent.filter(message => /Approved reply ready to paste/.test(message.subject)).length, OWNER_ADDRESSES.length);
  } finally { await pg.close(); }
});

test('invalid tokens and incomplete reviews are refused', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createReviewResponseHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env, generateResponse: generator });
  try {
    assert.equal((await handler(new Request('https://legacyai.space/api/frontdesk/review-response?token=bad'))).status, 401);
    assert.equal((await handler(create({ reviewer: 'X', rating: 9, review: 'ok' }))).status, 400);
    assert.equal((await handler(create({ reviewer: 'X', rating: 5, review: '' }))).status, 400);
    assert.equal(sent.length, 0);
  } finally { await pg.close(); }
});
