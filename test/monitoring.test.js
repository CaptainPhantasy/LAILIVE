import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createMonitor } from '../lib/monitoring.js';
import { signOwnerToken } from '../lib/owner-documents-core.js';
import { OWNER_ADDRESSES } from '../lib/frontdesk.js';

const env = {
  RECEPTIONIST_SESSION_SECRET: 'test-session-secret-at-least24characters',
  FRONTDESK_PUBLIC_ORIGIN: 'https://legacyai.space',
  MONITOR_SITE: 'https://legacyai.space',
};
const okFetch = async () => new Response('ok', { status: 200 });

test('a daily run records real checks, writes a backup, and verifies it', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  const monitor = createMonitor({ getDb: () => db, mail: async () => true, env, fetcher: okFetch, tlsDays: async () => 45 });
  try {
    await pg.query('CREATE TABLE legacy_contacts (id uuid PRIMARY KEY, name text NOT NULL, email text NOT NULL)');
    await pg.query("INSERT INTO legacy_contacts(id,name,email) VALUES ('11111111-1111-4111-8111-111111111111','A','a@example.com'),('22222222-2222-4222-8222-222222222222','B','b@example.com')");
    const result = await monitor.daily();
    assert.equal(result.http, true);
    assert.equal(result.tls, true);
    assert.equal(result.restore, true);
    assert.match(result.backup, /^[a-f0-9-]{36}$/);
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM legacy_monitor_checks')).rows[0].n, 3);
    assert.equal((await pg.query("SELECT count(*)::int AS n FROM legacy_monitor_checks WHERE kind='tls' AND ok")).rows[0].n, 1);
    assert.equal((await pg.query('SELECT sha256 FROM legacy_backups')).rows[0].sha256.length, 64);
    assert.match((await pg.query('SELECT payload FROM legacy_backups')).rows[0].payload, /"tables"/);
    const receipt = await monitor.receipt();
    assert.equal(receipt.restore.ok, true);
    assert.equal(receipt.restore.exported.legacy_contacts, 2);
  } finally { await pg.close(); }
});

test('a failing site and an expiring certificate are recorded as failures', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  const monitor = createMonitor({ getDb: () => db, mail: async () => true, env, fetcher: async () => new Response('down', { status: 500 }), tlsDays: async () => 5 });
  try {
    const result = await monitor.daily();
    assert.equal(result.http, false);
    assert.equal(result.tls, false);
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM legacy_monitor_checks WHERE NOT ok')).rows[0].n, 3);
  } finally { await pg.close(); }
});

test('a tampered backup fails the restore check', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  const monitor = createMonitor({ getDb: () => db, mail: async () => true, env, fetcher: okFetch, tlsDays: async () => 45 });
  try {
    const result = await monitor.daily();
    await pg.query("UPDATE legacy_backups SET payload='{\"rows\":{}}' WHERE id=$1", [result.backup]);
    const restored = await monitor.receipt();
    assert.equal(restored.restore.ok, false);
  } finally { await pg.close(); }
});

test('the monthly receipt is emailed with a signed page and the page is owner-only', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const monitor = createMonitor({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env, fetcher: okFetch, tlsDays: async () => 60 });
  try {
    await monitor.daily();
    const data = await monitor.emailReceipt();
    assert.equal(data.restore.ok, true);
    assert.equal(sent.length, OWNER_ADDRESSES.length);
    assert.match(sent[0].subject, /Monthly monitoring receipt/);
    const link = sent[0].body.match(/https:\/\/legacyai\.space\/api\/frontdesk\/monitor\?token=[A-Za-z0-9._-]+/)[0];
    const token = new URL(link).searchParams.get('token');
    assert.equal((await monitor.report('bad')).status, 401);
    const page = await monitor.report(token);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Monthly monitoring receipt/);
    assert.match(html, /exports real rows/);
    assert.match(html, /Backup restore test:<\/b> passed/);
  } finally { await pg.close(); }
});
