import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createCompetitorWatch } from '../lib/competitor-watch.js';
import { OWNER_ADDRESSES } from '../lib/frontdesk.js';

const env = { COMPETITOR_SECRET: 'watch-secret' };
const post = (body, secret = 'watch-secret') => new Request('https://legacyai.space/api/frontdesk/competitors-watch', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-frontdesk-secret': secret }, body: JSON.stringify(body),
});
const page = content => async () => new Response(`<html><body><h1>${content}</h1></body></html>`, { status: 200 });

test('a public page is added and seeded, and unsafe targets are refused', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  const watch = createCompetitorWatch({ getDb: () => db, mail: async () => true, env, fetcher: page('Seasonal offer') });
  try {
    assert.equal((await watch(post({ url: 'https://competitor.example/services' }, 'wrong'))).status, 401);
    assert.equal((await watch(post({ url: 'http://competitor.example' }))).status, 400);
    assert.equal((await watch(post({ url: 'https://localhost/page' }))).status, 400);
    const created = await (await watch(post({ url: 'https://competitor.example/services', label: 'Rival' }))).json();
    assert.equal(created.seeded, true);
    assert.equal((await pg.query('SELECT label,last_hash FROM legacy_competitor_sources')).rows[0].label, 'Rival');
    assert.equal((await pg.query('SELECT last_hash FROM legacy_competitor_sources')).rows[0].last_hash.length, 64);
    assert.equal((await watch(post({ url: 'https://competitor.example/services' }))).status, 409);
  } finally { await pg.close(); }
});

test('a changed page is recorded and emailed once per change', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = []; let body = 'Seasonal offer';
  const watch = createCompetitorWatch({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env, fetcher: async () => new Response(`<html><body><h1>${body}</h1><script>ignore()</script></body></html>`, { status: 200 }) });
  try {
    await watch(post({ url: 'https://competitor.example/services', label: 'Rival' }));
    assert.equal(sent.length, 0);
    const unchanged = await (await watch(post({ action: 'check' }))).json();
    assert.deepEqual({ checked: unchanged.checked, changed: unchanged.changed }, { checked: 1, changed: 0 });
    assert.equal(sent.length, 0);
    body = 'Spring offer with a new service';
    const changed = await (await watch(post({ action: 'check' }))).json();
    assert.deepEqual({ checked: changed.checked, changed: changed.changed }, { checked: 1, changed: 1 });
    assert.equal(sent.length, OWNER_ADDRESSES.length);
    assert.match(sent[0].subject, /Competitor page changed: Rival/);
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM legacy_competitor_changes')).rows[0].n, 1);
    assert.equal((await (await watch(post({ action: 'check' }))).json()).changed, 0);
    assert.equal(sent.length, OWNER_ADDRESSES.length);
  } finally { await pg.close(); }
});

test('one failing page does not stop the others and unknown actions are refused', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  let fail = false;
  const watch = createCompetitorWatch({ getDb: () => db, mail: async () => true, env, fetcher: async () => { if (fail) throw new Error('network down'); return new Response('<h1>ok</h1>', { status: 200 }); } });
  try {
    await watch(post({ url: 'https://one.example/', label: 'One' }));
    await watch(post({ url: 'https://two.example/', label: 'Two' }));
    fail = true;
    const result = await (await watch(post({ action: 'check' }))).json();
    assert.equal(result.checked, 0);
    assert.equal(result.failures.length, 2);
    assert.equal((await watch(post({ action: 'nope' }))).status, 400);
  } finally { await pg.close(); }
});
