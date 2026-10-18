import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createSignoffHandler } from '../lib/signoffs.js';
import { signOwnerToken } from '../lib/owner-documents-core.js';
import { OWNER_ADDRESSES } from '../lib/frontdesk.js';

const env = {
  RECEPTIONIST_SESSION_SECRET: 'test-session-secret-at-least24characters',
  FRONTDESK_PUBLIC_ORIGIN: 'https://legacyai.space',
};
const tokenFor = (id, scope = 'signoff') => signOwnerToken({ id, scope, exp: Date.now() + 86400000 }, env.RECEPTIONIST_SESSION_SECRET);
const urlFor = (id, extra = '') => `https://legacyai.space/api/frontdesk/signoff?token=${encodeURIComponent(tokenFor(id))}${extra}`;
const sign = (id, fields) => new Request(urlFor(id), {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ token: tokenFor(id), action: 'sign', ...fields }),
});
async function setup(pg, status = 'sent') {
  await pg.query(`CREATE TABLE IF NOT EXISTS legacy_owner_documents (id uuid PRIMARY KEY, call_id text NOT NULL, kind text NOT NULL, title text NOT NULL, content text NOT NULL, recipient text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'draft', version integer NOT NULL DEFAULT 1, notified_to text[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz)`);
  const id = '11111111-2222-4333-8444-555555555555';
  await pg.query(`INSERT INTO legacy_owner_documents(id,call_id,kind,title,content,recipient,status) VALUES ($1::uuid,'call-1','field_report','Test Report','Replaced the pump and checked the pressure.','customer@example.com',$2)`, [id, status]);
  return id;
}

test('a draft cannot be signed and a bad link is refused', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  const handler = createSignoffHandler({ getDb: () => db, mail: async () => true, env });
  try {
    const id = await setup(pg, 'draft');
    assert.equal((await handler(new Request('https://legacyai.space/api/frontdesk/signoff?token=bad'))).status, 401);
    assert.equal((await handler(new Request(urlFor(id)))).status, 409);
    assert.equal((await handler(sign(id, { name: 'Pat Doe', agree: 'yes' }))).status, 409);
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM legacy_document_signatures')).rows[0].n, 0);
  } finally { await pg.close(); }
});

test('a delivered document is signed once and the owners are emailed', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createSignoffHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env });
  try {
    const id = await setup(pg, 'sent');
    const form = await handler(new Request(urlFor(id)));
    const html = await form.text();
    assert.equal(form.status, 200);
    assert.match(html, /Type your full name to sign/);
    assert.match(html, /Replaced the pump/);
    assert.equal((await handler(sign(id, { name: 'Pat Doe' }))).status, 400);
    const signed = await handler(sign(id, { name: 'Pat Doe', agree: 'yes' }));
    assert.equal(signed.status, 200);
    assert.match(await signed.text(), /Download the signed PDF/);
    const row = (await pg.query('SELECT status FROM legacy_owner_documents')).rows[0];
    assert.equal(row.status, 'signed');
    const signature = (await pg.query('SELECT signer_name,signature_hash FROM legacy_document_signatures')).rows[0];
    assert.equal(signature.signer_name, 'Pat Doe');
    assert.match(signature.signature_hash, /^[a-f0-9]{64}$/);
    assert.equal(sent.length, OWNER_ADDRESSES.length);
    assert.match(sent[0].subject, /Signed: Test Report/);
    const before = sent.length;
    await handler(sign(id, { name: 'Someone Else', agree: 'yes' }));
    assert.equal(sent.length, before);
    assert.equal((await pg.query('SELECT signer_name FROM legacy_document_signatures')).rows[0].signer_name, 'Pat Doe');
  } finally { await pg.close(); }
});

test('the signed PDF renders and unsupported signature characters are rejected', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  const handler = createSignoffHandler({ getDb: () => db, mail: async () => true, env });
  try {
    const id = await setup(pg, 'sent');
    assert.equal((await handler(sign(id, { name: '😀 Emoji', agree: 'yes' }))).status, 400);
    await handler(sign(id, { name: 'Pat Doe', agree: 'yes' }));
    const response = await handler(new Request(`${urlFor(id)}&pdf=1`));
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/pdf/);
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
    assert.ok(bytes.length > 500);
    const text = bytes.toString('latin1');
    assert.match(text, /Signed by Pat Doe/);
  } finally { await pg.close(); }
});

test('a failed signature write leaves the document unsigned', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  try {
    const id = await setup(pg);
    const handler = createSignoffHandler({ getDb: () => db, mail: async () => true, env });
    await handler(new Request(urlFor(id)));
    await pg.query('ALTER TABLE legacy_document_signatures ADD CONSTRAINT force_fail CHECK (false)');
    const response = await handler(sign(id, { name: 'Pat Customer', agree: 'yes' }));
    assert.equal(response.status, 500);
    const row = (await pg.query('SELECT status FROM legacy_owner_documents WHERE id=$1::uuid', [id])).rows[0];
    assert.equal(row.status, 'sent');
    const signatures = (await pg.query('SELECT count(*)::int AS count FROM legacy_document_signatures')).rows[0];
    assert.equal(signatures.count, 0);
  } finally { await pg.close(); }
});
