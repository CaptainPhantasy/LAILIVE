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
    assert.match(html, /Application export integrity check:<\/b> passed/);
    assert.doesNotMatch(html, /Backup restore test/);
    assert.match(sent[0].body, /Application export integrity: passed/);
    assert.doesNotMatch(sent[0].body, /Backup restore: passed/);
  } finally { await pg.close(); }
});

test('one outage alerts only the owners once, persists across runs, and a later outage alerts again', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  let down = true;
  const options = { getDb: () => db, mail: async message => { sent.push(message); return true; }, env,
    fetcher: async () => new Response(down ? 'down' : 'ok', { status: down ? 503 : 200 }), tlsDays: async () => 45 };
  try {
    const first = await createMonitor(options).daily();
    assert.equal(sent.length, OWNER_ADDRESSES.length);
    assert.equal(first.alerts.pending, 0);
    for (const message of sent) {
      assert(OWNER_ADDRESSES.includes(message.to));
      assert.match(message.subject, /Monitoring alert/);
      assert.match(message.body, /https:\/\/legacyai.space\//);
      assert.match(message.body, /sitemap.xml/);
      assert.match(message.body, /status 503/);
      assert.match(message.body, /deployment|hosting/i);
    }
    await createMonitor(options).daily();
    assert.equal(sent.length, OWNER_ADDRESSES.length, 'same outage is not sent again after restart');
    down = false;
    await createMonitor(options).daily();
    assert.equal(sent.length, OWNER_ADDRESSES.length, 'recovery needs no additional email');
    down = true;
    await createMonitor(options).daily();
    assert.equal(sent.length, OWNER_ADDRESSES.length * 2, 'a new incident alerts again');
  } finally { await pg.close(); }
});

test('only a failed owner address is retried, including after the checks recover', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const attempts = [], accepted = [];
  let reject = true, down = true;
  const options = { getDb: () => db, env, tlsDays: async () => 45,
    fetcher: async () => new Response('state', { status: down ? 500 : 200 }),
    mail: async message => {
      attempts.push(message.to);
      if (reject && message.to === OWNER_ADDRESSES[1]) throw new Error('provider unavailable');
      accepted.push(message); return true;
    } };
  try {
    const first = await createMonitor(options).daily();
    assert.equal(first.alerts.pending, 2, 'two failed checks remain queued for the rejected owner');
    assert.equal(accepted.length, 1);
    reject = false; down = false;
    const retry = await createMonitor(options).daily();
    assert.equal(retry.alerts.pending, 0);
    assert.deepEqual(attempts, [OWNER_ADDRESSES[0], OWNER_ADDRESSES[1], OWNER_ADDRESSES[1]]);
    assert.match(accepted[1].body, /recovered/i);
  } finally { await pg.close(); }
});

test('a false mail result stays pending and a new failed check alerts during an existing incident', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  let httpDown = false, mailAccepted = false;
  const options = { getDb: () => db, env, tlsDays: async () => 5,
    fetcher: async () => new Response('state', { status: httpDown ? 502 : 200 }),
    mail: async message => { if (mailAccepted) sent.push(message); return mailAccepted; } };
  try {
    assert.equal((await createMonitor(options).daily()).alerts.pending, OWNER_ADDRESSES.length);
    mailAccepted = true;
    await createMonitor(options).daily();
    assert.equal(sent.length, OWNER_ADDRESSES.length);
    assert.match(sent[0].body, /5 days remaining/);
    httpDown = true;
    await createMonitor(options).daily();
    assert.equal(sent.length, OWNER_ADDRESSES.length * 2, 'new outage is not hidden by an ongoing certificate alert');
    assert.match(sent.at(-1).body, /status 502/);
  } finally { await pg.close(); }
});

test('overlapping runs do not claim an owner alert while its email is in progress', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const monitor = createMonitor({ getDb: () => db, env, tlsDays: async () => 45,
    fetcher: async () => new Response('down', { status: 503 }),
    mail: async message => {
      sent.push(message);
      if (message.to === OWNER_ADDRESSES[0]) { enter(); await blocked; }
      return true;
    } });
  try {
    await monitor.receipt();
    const first = monitor.daily();
    await entered;
    await monitor.daily();
    assert.equal(sent.filter(message => message.to === OWNER_ADDRESSES[0]).length, 1);
    release();
    await first;
    assert.equal(sent.length, OWNER_ADDRESSES.length);
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM legacy_monitor_alerts WHERE accepted_at IS NULL')).rows[0].n, 0);
  } finally { release(); await pg.close(); }
});

test('an abandoned email claim is retried after its lease expires', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  let stamp = Date.parse('2026-10-19T14:00:00Z'), accept = false;
  const monitor = createMonitor({ getDb: () => db, env, now: () => stamp, tlsDays: async () => 5,
    fetcher: okFetch, mail: async message => { if (accept) sent.push(message); return accept; } });
  try {
    await monitor.daily();
    // Represents a worker that stopped after claiming, before receiving an email result.
    await pg.query("UPDATE legacy_monitor_alerts SET lease_token='11111111-1111-4111-8111-111111111111',lease_until=$1", [new Date(stamp + 10 * 60000).toISOString()]);
    accept = true;
    assert.equal((await monitor.daily()).alerts.pending, OWNER_ADDRESSES.length);
    assert.equal(sent.length, 0);
    stamp += 11 * 60000;
    assert.equal((await monitor.daily()).alerts.pending, 0);
    assert.equal(sent.length, OWNER_ADDRESSES.length);
  } finally { await pg.close(); }
});

test('a failed export write does not prevent an already recorded outage alert', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const monitor = createMonitor({ getDb: () => db, env, tlsDays: async () => 45,
    fetcher: async () => new Response('down', { status: 503 }),
    mail: async message => { sent.push(message); return true; } });
  try {
    await monitor.receipt();
    await pg.query('ALTER TABLE legacy_backups ADD CONSTRAINT simulate_export_failure CHECK (false)');
    await assert.rejects(monitor.daily());
    assert.equal(sent.length, OWNER_ADDRESSES.length);
  } finally { await pg.close(); }
});

test('an older slow failed run cannot reopen an incident after a newer healthy run', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  let stamp = Date.parse('2026-10-19T14:00:00Z'), pause = true, enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const monitor = createMonitor({ getDb: () => db, env, now: () => stamp, tlsDays: async () => 45,
    fetcher: async () => { if (pause) { enter(); await blocked; return new Response('down', { status: 503 }); } return new Response('ok'); },
    mail: async message => { sent.push(message); return true; } });
  try {
    await monitor.receipt();
    const oldRun = monitor.daily();
    await entered;
    stamp += 60000; pause = false;
    await monitor.daily();
    release();
    await oldRun;
    assert.equal(sent.length, 0, 'out-of-order stale failure does not send an outage email');
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM legacy_monitor_incidents WHERE recovered_at IS NULL')).rows[0].n, 0);
  } finally { release(); await pg.close(); }
});

test('a queued alert for a removed recipient is retired instead of blocking the pending count', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const monitor = createMonitor({ getDb: () => db, env, tlsDays: async () => 5,
    fetcher: async () => new Response('down', { status: 503 }),
    mail: async message => { sent.push(message); return true; } });
  try {
    await monitor.daily();
    // A queued alert for an address that later left OWNER_ADDRESSES can never
    // be leased or accepted; the next run must retire it instead of counting
    // it as pending forever.
    const incident = (await pg.query('SELECT id FROM legacy_monitor_incidents LIMIT 1')).rows[0].id;
    await pg.query('INSERT INTO legacy_monitor_alerts(incident,recipient) VALUES ($1,$2)', [incident, 'gone@example.test']);
    assert.equal((await monitor.daily()).alerts.pending, 0, 'a removed recipient no longer counts as pending');
    assert.equal((await pg.query("SELECT count(*)::int AS n FROM legacy_monitor_alerts WHERE recipient='gone@example.test'")).rows[0].n, 0);
  } finally { await pg.close(); }
});

test('a monthly receipt rejected by the mail connection is not reported as accepted', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  const monitor = createMonitor({ getDb: () => db, env, fetcher: okFetch, tlsDays: async () => 45, mail: async () => false });
  try {
    await monitor.daily();
    await assert.rejects(monitor.emailReceipt(), /not accepted/);
  } finally { await pg.close(); }
});
