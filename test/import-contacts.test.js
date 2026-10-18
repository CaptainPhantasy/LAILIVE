import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createContactImportHandler } from '../lib/import-contacts.js';
import { OWNER_ADDRESSES } from '../lib/frontdesk.js';

const env = { IMPORT_SECRET: 'import-secret', RECEPTIONIST_SESSION_SECRET: 'test-session-secret-at-least24characters' };
const csv = [
  'Name,Email,Phone,Company',
  'Alice New,Alice@Example.com,8125550101,Alice Plumbing',
  'Alice Again,alice@example.com,8125550101,Alice Plumbing',
  'Bob Old,bob@example.com,,Bob Heating',
  'No Email,,8125550102,No Email Co',
].join('\n');
const post = (body, secret = 'import-secret') => new Request('https://legacyai.space/api/frontdesk/import-contacts', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-frontdesk-secret': secret }, body: JSON.stringify(body),
});
async function setup(pg) {
  await pg.query('CREATE TABLE legacy_contacts (id uuid PRIMARY KEY, name text NOT NULL, email text NOT NULL, company text NOT NULL DEFAULT \'\', created_at timestamptz NOT NULL DEFAULT now())');
  await pg.query("INSERT INTO legacy_contacts(id,name,email,company) VALUES ('11111111-1111-4111-8111-111111111111','Bob Old','bob@example.com','Bob Heating')");
}

test('preview counts what would land and writes nothing', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  const handler = createContactImportHandler({ getDb: () => db, mail: async () => true, env });
  try {
    await setup(pg);
    const preview = await (await handler(post({ action: 'preview', filename: 'list.csv', csv }))).json();
    assert.equal(preview.preview, true);
    assert.equal(preview.total, 4);
    assert.equal(preview.create, 1);
    assert.equal(preview.duplicates, 2);
    assert.equal(preview.skipped, 1);
    assert.equal(preview.reasons['repeated in this file'], 1);
    assert.equal(preview.reasons['already in the contact store'], 1);
    assert.equal(preview.sample.length, 1);
    assert.equal(preview.sample[0].email, 'alice@example.com');
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM legacy_contacts')).rows[0].n, 1);
  } finally { await pg.close(); }
});

test('commit creates only new contacts, keeps the phone, records the run, and emails the owners', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createContactImportHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env });
  try {
    await setup(pg);
    const result = await (await handler(post({ action: 'commit', filename: 'list.csv', csv }))).json();
    assert.equal(result.created, 1);
    assert.equal(result.duplicates, 2);
    assert.equal(result.skipped, 1);
    const rows = (await pg.query('SELECT name,email,company FROM legacy_contacts ORDER BY email')).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].email, 'alice@example.com');
    assert.equal(rows[0].company, 'Alice Plumbing');
    assert.equal((await pg.query('SELECT phone FROM legacy_contact_phones')).rows[0].phone, '8125550101');
    assert.equal((await pg.query('SELECT created,duplicates,skipped FROM legacy_import_runs')).rows[0].created, 1);
    assert.equal(sent.length, OWNER_ADDRESSES.length);
    assert.match(sent[0].body, /Created: 1/);
    const again = await (await handler(post({ action: 'commit', filename: 'list.csv', csv }))).json();
    assert.equal(again.created, 0);
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM legacy_contacts')).rows[0].n, 2);
  } finally { await pg.close(); }
});

test('bad secrets and unusable files are refused', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  const handler = createContactImportHandler({ getDb: () => db, mail: async () => true, env });
  try {
    await setup(pg);
    assert.equal((await handler(post({ action: 'commit', csv }, 'wrong'))).status, 401);
    assert.equal((await handler(post({ action: 'commit', csv: 'Name,Phone\nNo Email,812' }))).status, 400);
    assert.equal((await handler(post({ action: 'commit', csv: '' }))).status, 400);
  } finally { await pg.close(); }
});
