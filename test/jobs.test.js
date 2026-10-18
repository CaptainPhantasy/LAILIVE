import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createJobHandler } from '../lib/jobs.js';
import { OWNER_ADDRESSES } from '../lib/frontdesk.js';

const env = {
  RECEPTIONIST_SESSION_SECRET: 'test-session-secret-at-least24characters',
  FRONTDESK_PUBLIC_ORIGIN: 'https://legacyai.space',
  JOBS_SECRET: 'jobs-secret',
};
const create = (body, secret = 'jobs-secret') => new Request('https://legacyai.space/api/frontdesk/jobs', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-frontdesk-secret': secret },
  body: JSON.stringify(body),
});
const linkFrom = text => (text.match(/https:\/\/legacyai\.space\/api\/frontdesk\/jobs\?token=[A-Za-z0-9._-]+/) || [])[0];
const tokenOf = url => new URL(url).searchParams.get('token');
const advance = token => new Request(`https://legacyai.space/api/frontdesk/jobs?token=${encodeURIComponent(token)}`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token, action: 'advance' }),
});

test('a job is created with a technician link and only the owners are emailed', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createJobHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env });
  try {
    assert.equal((await handler(create({ job_id: 'JOB-1', customer_name: 'Pat Doe' }, 'wrong'))).status, 401);
    const created = await (await handler(create({ job_id: 'JOB-1', customer_name: 'Pat Doe', service: 'Water heater', address: '1 Main St' }))).json();
    assert.equal(created.status, 'scheduled');
    assert.equal(sent.length, OWNER_ADDRESSES.length);
    assert.ok(sent.every(message => OWNER_ADDRESSES.includes(message.to)));
    assert.match(sent[0].body, /Technician page:/);
    assert.equal((await handler(create({ job_id: 'JOB-1', customer_name: 'Other' }))).status, 409);
    assert.match(await (await handler(new Request(linkFrom(sent[0].body)))).text(), /Mark en route/);
  } finally { await pg.close(); }
});

test('each tap advances exactly one step and completion emails the owners once', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createJobHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env });
  try {
    await handler(create({ job_id: 'JOB-2', customer_name: 'Lee Roe', service: 'Repair' }));
    const token = tokenOf(linkFrom(sent[0].body));
    for (const expected of ['en_route', 'on_site', 'working', 'done']) {
      const html = await (await handler(advance(token))).text();
      assert.match(html, new RegExp(`Status: <b>${expected.replace('_', ' ')}</b>`));
    }
    const before = sent.length;
    const done = await (await handler(advance(token))).text();
    assert.match(done, /This job is already complete/);
    assert.equal(sent.length, before);
    const row = (await pg.query('SELECT status,done_at FROM legacy_jobs')).rows[0];
    assert.equal(row.status, 'done');
    assert.ok(row.done_at);
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM legacy_job_events')).rows[0].n, 5);
    assert.equal(sent.filter(message => /Job complete: Lee Roe/.test(message.subject)).length, OWNER_ADDRESSES.length);
  } finally { await pg.close(); }
});

test('the owner can request a signed job list that links to every job', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createJobHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env });
  try {
    await handler(create({ job_id: 'JOB-A', customer_name: 'First Customer', service: 'Repair' }));
    await handler(create({ job_id: 'JOB-B', customer_name: 'Second Customer', service: 'Install' }));
    const reply = await handler(create({ action: 'list' }));
    assert.equal(reply.status, 200);
    const { url } = await reply.json();
    assert.match(url, /\/api\/frontdesk\/jobs\?list=/);
    const list = await handler(new Request(url));
    const html = await list.text();
    assert.equal(list.status, 200);
    assert.match(html, /First Customer/);
    assert.match(html, /Second Customer/);
    assert.match(html, /JOB-A/);
    assert.match(html, /Open job/);
    assert.match(html, /api\/frontdesk\/jobs\?token=/);
    assert.equal((await handler(new Request('https://legacyai.space/api/frontdesk/jobs?list=bad'))).status, 401);
  } finally { await pg.close(); }
});

test('invalid links and incomplete job payloads are refused', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createJobHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env });
  try {
    assert.equal((await handler(new Request('https://legacyai.space/api/frontdesk/jobs?token=bad'))).status, 401);
    assert.equal((await handler(advance('bad'))).status, 401);
    assert.equal((await handler(create({ job_id: 'bad id!', customer_name: 'X' }))).status, 400);
    assert.equal((await handler(create({ job_id: 'JOB-3', customer_name: '' }))).status, 400);
    assert.equal(sent.length, 0);
  } finally { await pg.close(); }
});

test('a job can be assigned with a recorded receipt and an owner email', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createJobHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env });
  try {
    await handler(create({ job_id: 'JOB-ASSIGN', customer_name: 'Assign Customer', service: 'Repair' }));
    assert.equal((await handler(create({ action: 'assign', job_id: 'NO-JOB', technician: 'Alex' }))).status, 404);
    assert.equal((await handler(create({ action: 'assign', job_id: 'JOB-ASSIGN', technician: '  ' }))).status, 400);
    const assigned = await (await handler(create({ action: 'assign', job_id: 'JOB-ASSIGN', technician: 'Alex' }))).json();
    assert.equal(assigned.technician, 'Alex');
    assert.equal((await pg.query("SELECT assigned_to FROM legacy_jobs WHERE job_id='JOB-ASSIGN'")).rows[0].assigned_to, 'Alex');
    assert.equal((await pg.query("SELECT count(*)::int AS n FROM legacy_job_events WHERE status='assigned' AND detail='Alex'")).rows[0].n, 1);
    assert.equal(sent.filter(message => /Job assigned: Assign Customer/.test(message.subject)).length, OWNER_ADDRESSES.length);
  } finally { await pg.close(); }
});
