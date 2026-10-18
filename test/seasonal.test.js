import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createSeasonal } from '../lib/seasonal.js';
import { OWNER_ADDRESSES } from '../lib/frontdesk.js';

const env = {
  RECEPTIONIST_SESSION_SECRET: 'test-session-secret-at-least24characters',
  FRONTDESK_PUBLIC_ORIGIN: 'https://legacyai.space',
  SEASONAL_SECRET: 'seasonal-secret',
};
const post = (body, secret = 'seasonal-secret') => new Request('https://legacyai.space/api/frontdesk/seasonal', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-frontdesk-secret': secret }, body: JSON.stringify(body),
});
const november27 = () => Date.parse('2026-11-27T15:00:00Z');
const generator = async ({ topic }) => `A seasonal note about ${topic} for Indiana homeowners.`;

test('a rule is validated and listed', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  const seasonal = createSeasonal({ getDb: () => db, mail: async () => true, env, now: november27, draft: generator });
  try {
    assert.equal((await seasonal(post({ name: 'X', month: 11, day: 27, topic: 'Winter plumbing' }, 'wrong'))).status, 401);
    assert.equal((await seasonal(post({ name: 'T', month: 13, day: 27, topic: 'Winter plumbing' }))).status, 400);
    assert.equal((await seasonal(post({ name: 'T', month: 11, day: 29, topic: 'Winter plumbing' }))).status, 400);
    assert.equal((await seasonal(post({ name: 'T', month: 11, day: 27, channel: 'radio', topic: 'Winter plumbing' }))).status, 400);
    const created = await (await seasonal(post({ name: 'First freeze', month: 11, day: 27, channel: 'email', topic: 'Winter plumbing check' }))).json();
    assert.equal(created.month, 11);
    const list = await (await seasonal(post({ action: 'list' }))).json();
    assert.equal(list.rules.length, 1);
    assert.equal(list.rules[0].name, 'First freeze');
  } finally { await pg.close(); }
});

test('a matching rule fires once per year and creates a reviewable draft', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const seasonal = createSeasonal({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env, now: november27, draft: generator });
  try {
    await seasonal(post({ name: 'First freeze', month: 11, day: 27, channel: 'email', topic: 'Winter plumbing check' }));
    await seasonal(post({ name: 'Spring start', month: 12, day: 1, channel: 'blog', topic: 'Spring start up' }));
    const fired = await (await seasonal(post({ action: 'run' }))).json();
    assert.equal(fired.fired, 1);
    assert.equal(fired.created[0].rule, 'First freeze');
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM legacy_content_drafts')).rows[0].n, 1);
    assert.equal((await pg.query('SELECT status FROM legacy_content_drafts')).rows[0].status, 'draft');
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM legacy_seasonal_runs')).rows[0].n, 1);
    assert.equal(sent.filter(message => /Seasonal draft ready/.test(message.subject)).length, OWNER_ADDRESSES.length);
    assert.match(sent[0].body, /\/api\/frontdesk\/content\?token=/);
    assert.equal((await (await seasonal(post({ action: 'run' }))).json()).fired, 0);
  } finally { await pg.close(); }
});

test('a failed writer still creates an empty draft for the owner to write', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const seasonal = createSeasonal({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env, now: november27, draft: async () => { throw new Error('provider down'); } });
  try {
    await seasonal(post({ name: 'First freeze', month: 11, day: 27, topic: 'Winter plumbing check' }));
    const fired = await (await seasonal(post({ action: 'run' }))).json();
    assert.equal(fired.fired, 1);
    assert.equal(fired.created[0].generated, false);
    assert.equal((await pg.query('SELECT draft FROM legacy_content_drafts')).rows[0].draft, '');
    assert.match(sent[0].body, /No draft was generated/);
  } finally { await pg.close(); }
});
