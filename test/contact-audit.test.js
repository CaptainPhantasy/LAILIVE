import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createContactAuditHandler } from '../lib/contact-audit.js';
import { OWNER_ADDRESSES } from '../lib/frontdesk.js';

const env = {
  RECEPTIONIST_SESSION_SECRET: 'test-session-secret-at-least24characters',
  OWNER_AUDIT_SECRET: 'audit-secret',
  FRONTDESK_PUBLIC_ORIGIN: 'https://legacyai.space',
};
const request = (body, secret = 'audit-secret') => new Request('https://legacyai.space/api/frontdesk/contact-audit', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-owner-audit-secret': secret },
  body: JSON.stringify(body),
});

test('a contact CSV is audited, cleaned, stored, and emailed as a signed download', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createContactAuditHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env });
  try {
    const csv = 'name,email,phone\nAlice,alice@example.com,\nAlice,alice@example.com,\nBob,,555-0100\n,carol@example.com,\n';
    const response = await handler(request({ filename: 'test-contacts.csv', csv }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.summary.records, 4);
    assert.equal(body.summary.exactDuplicates, 1);
    assert.equal(body.summary.rowsKept, 3);
    assert.equal(sent.length, OWNER_ADDRESSES.length);
    assert.match(sent[0].subject, /Contact-list audit: test-contacts\.csv/);
    assert.match(sent[0].body, /Download the cleaned CSV:/);

    const download = await handler(new Request(body.download));
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-type'), /text\/csv/);
    const cleaned = await download.text();
    assert.equal((cleaned.match(/Alice/g) || []).length, 1);
    assert.match(cleaned, /Bob/);
    assert.match(cleaned, /carol@example\.com/);
  } finally { await pg.close(); }
});

test('the contact audit rejects a wrong secret and an invalid download token', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  const handler = createContactAuditHandler({ getDb: () => db, mail: async () => true, env });
  try {
    assert.equal((await handler(request({ csv: 'name,email\nA,a@example.com\nB,b@example.com\n' }, 'wrong'))).status, 401);
    assert.equal((await handler(new Request('https://legacyai.space/api/frontdesk/contact-audit?token=bad'))).status, 401);
  } finally { await pg.close(); }
});
