import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createOwnerJobsHandler } from '../lib/owner-jobs.js';

const jobId = '11111111-2222-4333-8444-555555555555';
async function setup(pg) {
  await pg.query('CREATE TABLE legacy_jobs (id uuid PRIMARY KEY, job_id text NOT NULL UNIQUE, customer_name text NOT NULL, service text NOT NULL DEFAULT \'\', status text NOT NULL, assigned_to text NOT NULL DEFAULT \'\', source text NOT NULL DEFAULT \'\', created_at timestamptz NOT NULL DEFAULT now())');
  await pg.query(`INSERT INTO legacy_jobs(id,job_id,customer_name,service,status,assigned_to,source) VALUES
    ($1::uuid,'JOB-1','Pat Customer','Repair','done','Alex','Google Ads'),
    ('22222222-3333-4444-8555-666666666666','JOB-2','Sam Customer','Install','scheduled','','Referral')`, [jobId]);
}
const request = (method = 'GET') => new Request('https://legacyai.space/api/owner/jobs', { method });

test('the owner session is required before any job is read', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  try {
    await setup(pg);
    const denied = createOwnerJobsHandler({ getDb: () => db, requireOwner: async () => { const error = new Error('Sign in to the owner workspace.'); error.status = 401; throw error; } });
    const response = await denied(request());
    assert.equal(response.status, 401);
    assert.match((await response.json()).error, /Sign in/);
    const wrongMethod = createOwnerJobsHandler({ getDb: () => db, requireOwner: async () => ({}) });
    assert.equal((await wrongMethod(request('POST'))).status, 405);
  } finally { await pg.close(); }
});

test('an authorized owner gets the job list without signed links', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  try {
    await setup(pg);
    let calls = 0;
    const handler = createOwnerJobsHandler({ getDb: () => db, requireOwner: async () => { calls++; return { email: 'owner@example.com' }; } });
    const response = await handler(request());
    assert.equal(response.status, 200);
    assert.equal(calls, 1);
    const body = await response.json();
    assert.equal(body.jobs.length, 2);
    assert.deepEqual(body.jobs.map(job => job.jobId).sort(), ['JOB-1', 'JOB-2']);
    const first = body.jobs.find(job => job.jobId === 'JOB-1');
    assert.equal(first.status, 'done');
    assert.equal(first.technician, 'Alex');
    assert.equal(first.source, 'Google Ads');
    assert.equal(JSON.stringify(body).includes('token='), false);
  } finally { await pg.close(); }
});

test('a store failure returns a safe error instead of leaking detail', async () => {
  const handler = createOwnerJobsHandler({ getDb: () => ({ execute: async () => { throw new Error('relation "legacy_jobs" does not exist'); } }), requireOwner: async () => ({}) });
  const response = await handler(request());
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, 'The job list could not be loaded.');
});
