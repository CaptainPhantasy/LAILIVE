import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createContentWriter } from '../lib/content-writer.js';
import { signOwnerToken } from '../lib/owner-documents-core.js';
import { OWNER_ADDRESSES } from '../lib/frontdesk.js';

const env = {
  RECEPTIONIST_SESSION_SECRET: 'test-session-secret-at-least24characters',
  FRONTDESK_PUBLIC_ORIGIN: 'https://legacyai.space',
  CONTENT_SECRET: 'content-secret',
};
const add = (body, secret = 'content-secret') => new Request('https://legacyai.space/api/frontdesk/content', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-frontdesk-secret': secret }, body: JSON.stringify(body),
});
const tokenFor = id => signOwnerToken({ id, scope: 'content', exp: Date.now() + 86400000 }, env.RECEPTIONIST_SESSION_SECRET);
const linkFor = id => `https://legacyai.space/api/frontdesk/content?token=${encodeURIComponent(tokenFor(id))}`;
const decide = (id, fields) => new Request(linkFor(id), {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ token: tokenFor(id), ...fields }),
});
const draftText = 'A water heater usually lasts about a decade, but hard water and poor maintenance shorten that. If yours is older, ask us for a check before it fails on a cold night.';
const generator = async ({ topic }) => `${draftText}\n\nTopic: ${topic}`;

test('a failed writer still stores a usable draft for the owner', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const writer = createContentWriter({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env, draft: async () => { throw new Error('provider down'); } });
  try {
    assert.equal((await writer(add({ topic: 'Water heater lifespan' }, 'wrong'))).status, 401);
    assert.equal((await writer(add({ topic: '' }))).status, 400);
    assert.equal((await writer(add({ topic: 'X', channel: 'billboard' }))).status, 400);
    const created = await (await writer(add({ topic: 'Water heater lifespan', channel: 'blog' }))).json();
    assert.equal(created.generated, false);
    assert.equal((await pg.query('SELECT draft FROM legacy_content_drafts')).rows[0].draft, '');
    assert.match(sent[0].body, /No draft was generated/);
  } finally { await pg.close(); }
});

test('the owner edits, saves, and approves a draft exactly once', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const writer = createContentWriter({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env, draft: generator });
  try {
    const created = await (await writer(add({ topic: 'Water heater lifespan', channel: 'email' }))).json();
    assert.equal(created.generated, true);
    const page = await (await writer(new Request(linkFor(created.id)))).text();
    assert.match(page, /water heater usually lasts/i);
    assert.equal((await writer(decide(created.id, { action: 'save', version: '1', draft: 'short' }))).status, 400);
    await writer(decide(created.id, { action: 'save', version: '1', draft: `${draftText}\n\nEdited by Douglas.` }));
    assert.equal((await pg.query('SELECT version FROM legacy_content_drafts')).rows[0].version, 2);
    const approved = await writer(decide(created.id, { action: 'approve', version: '2', draft: `${draftText}\n\nEdited by Douglas.` }));
    assert.match(await approved.text(), /Approved\. Copy it where you want it/);
    const row = (await pg.query('SELECT status,draft,decided_at IS NOT NULL AS decided FROM legacy_content_drafts')).rows[0];
    assert.equal(row.status, 'approved');
    assert.equal(row.decided, true);
    assert.match(row.draft, /Edited by Douglas/);
    const before = sent.length;
    await writer(decide(created.id, { action: 'reject', version: '3' }));
    assert.equal(sent.length, before);
    assert.equal((await pg.query('SELECT status FROM legacy_content_drafts')).rows[0].status, 'approved');
    assert.equal(sent.filter(message => /Content approved/.test(message.subject)).length, OWNER_ADDRESSES.length);
  } finally { await pg.close(); }
});

test('a rejected draft is closed and invalid links are refused', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  const writer = createContentWriter({ getDb: () => db, mail: async () => true, env, draft: generator });
  try {
    const created = await (await writer(add({ topic: 'Spring maintenance', channel: 'social' }))).json();
    assert.match(await (await writer(decide(created.id, { action: 'reject', version: '1' }))).text(), /Rejected/);
    assert.equal((await pg.query('SELECT status FROM legacy_content_drafts')).rows[0].status, 'rejected');
    assert.equal((await writer(new Request('https://legacyai.space/api/frontdesk/content?token=bad'))).status, 401);
  } finally { await pg.close(); }
});
