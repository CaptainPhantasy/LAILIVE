import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createProspectHunter } from '../lib/prospects.js';
import { signOwnerToken } from '../lib/owner-documents-core.js';
import { OWNER_ADDRESSES } from '../lib/frontdesk.js';

const env = {
  RECEPTIONIST_SESSION_SECRET: 'test-session-secret-at-least24characters',
  FRONTDESK_PUBLIC_ORIGIN: 'https://legacyai.space',
  PROSPECT_SECRET: 'prospect-secret',
};
const csv = [
  'Name,Business,Phone,Email,Service',
  'Pat Prospect,Pat Plumbing,8125550201,pat@example.com,Water heaters',
  'Pat Prospect,Pat Plumbing,8125550201,pat@example.com,Water heaters',
  'Sam Prospect,Sam Heating,,sam@example.com,Furnaces',
  'No Contact Row,Unknown Co,,,Repairs',
].join('\n');
const post = (body, secret = 'prospect-secret') => new Request('https://legacyai.space/api/frontdesk/prospects', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-frontdesk-secret': secret }, body: JSON.stringify(body),
});
const token = () => signOwnerToken({ scope: 'prospects', exp: Date.now() + 86400000 }, env.RECEPTIONIST_SESSION_SECRET);

test('the import keeps valid new prospects and counts the rest', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  const hunter = createProspectHunter({ getDb: () => db, mail: async () => true, env });
  try {
    assert.equal((await hunter(post({ action: 'import', csv }, 'wrong'))).status, 401);
    const result = await (await hunter(post({ action: 'import', csv }))).json();
    assert.equal(result.total, 4);
    assert.equal(result.created, 2);
    assert.equal(result.duplicates, 1);
    assert.equal(result.skipped, 1);
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM legacy_prospects')).rows[0].n, 2);
  } finally { await pg.close(); }
});

test('the nightly hunt reports each prospect once and emails the owners', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const hunter = createProspectHunter({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env });
  try {
    await hunter(post({ action: 'import', csv }));
    const first = await (await hunter(post({ action: 'hunt' }))).json();
    assert.equal(first.count, 2);
    assert.equal(sent.length, OWNER_ADDRESSES.length);
    assert.match(sent[0].subject, /Daily prospect report: 2/);
    assert.match(sent[0].body, /No prospect was contacted/);
    assert.equal((await pg.query("SELECT count(*)::int AS n FROM legacy_prospects WHERE status='reported'")).rows[0].n, 2);
    assert.equal((await pg.query('SELECT count FROM legacy_prospect_runs')).rows[0].count, 2);
    assert.equal((await (await hunter(post({ action: 'hunt' }))).json()).count, 0);
  } finally { await pg.close(); }
});

test('the signed report lists prospects and rejects a bad token', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  const hunter = createProspectHunter({ getDb: () => db, mail: async () => true, env });
  try {
    await hunter(post({ action: 'import', csv }));
    await hunter(post({ action: 'hunt' }));
    const report = await hunter(new Request(`https://legacyai.space/api/frontdesk/prospects?token=${encodeURIComponent(token())}`));
    const html = await report.text();
    assert.equal(report.status, 200);
    assert.match(html, /Pat Prospect/);
    assert.match(html, /Sam Heating/);
    assert.match(html, /Nothing was scraped/);
    assert.equal((await hunter(new Request('https://legacyai.space/api/frontdesk/prospects?token=bad'))).status, 401);
  } finally { await pg.close(); }
});
