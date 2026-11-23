import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantHandlers, similarQuestions, questionTokens, localParts, digestSlot, composeDigest, composeAlert, createOwnerMailer } from '../lib/assistant.js';
import { HttpError } from '../lib/concierge/contracts.js';

const env = { ASSISTANT_TOOL_SECRET: 'tool-secret', CRON_SECRET: 'cron-secret' };
// Fake drizzle handle: answers the handful of statements the assistant store issues.
function fakeDb() {
  const events = [];
  return { events, execute: async query => {
    const text = query.queryChunks ? query.queryChunks.map(c => c.value?.join?.('') ?? '').join('?') : String(query.sql || '');
    const params = query.queryChunks ? query.queryChunks.filter(c => !c.value) : [];
    if (/CREATE TABLE/.test(text)) return { rows: [] };
    if (/INSERT INTO legacy_assistant_events/.test(text)) { const [id, kind, channel, visitor_name, contact, question, summary, conversation_id] = params; const row = { id, kind, channel, visitor_name, contact, question, summary, conversation_id, emailed: false, created_at: new Date().toISOString() }; events.push(row); return { rows: [row] }; }
    if (/UPDATE legacy_assistant_events/.test(text)) { events.find(e => e.id === params[0]).emailed = true; return { rows: [] }; }
    if (/FROM legacy_assistant_events/.test(text)) return { rows: [...events] };
    return { rows: [] };
  } };
}
function limiter() { const counts = new Map(); return { consumeLimits: async rules => { for (const r of rules) { const n = (counts.get(r.key) || 0) + 1; if (n > r.limit) throw new HttpError(429, 'limit'); counts.set(r.key, n); } } }; }
const post = (body, secret = 'tool-secret') => new Request('https://legacyai.space/api/assistant/notify', { method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'x-assistant-secret': secret } : {}) }, body: JSON.stringify(body) });

test('the notify tool rejects calls without the shared secret before saving anything', async () => {
  const db = fakeDb(), sent = [];
  const h = createAssistantHandlers({ getDb: () => db, getStore: limiter, mail: async m => sent.push(m), env });
  for (const secret of [null, 'wrong']) assert.equal((await h.notify(post({ kind: 'contact_request', question: 'Call me' }, secret))).status, 401);
  assert.equal(db.events.length, 0); assert.equal(sent.length, 0);
});

test('a contact request is saved and emailed; the recipient is always the owner', async () => {
  const db = fakeDb(), bodies = [];
  const mail = createOwnerMailer({ env: { OWNER_NOTIFY_WEBHOOK_URL: 'https://hooks.example.test/x' }, fetcher: async (url, init) => { bodies.push(JSON.parse(init.body)); return new Response('ok'); } });
  const h = createAssistantHandlers({ getDb: () => db, getStore: limiter, mail, env });
  const res = await h.notify(post({ kind: 'contact_request', visitor_name: 'Ann', contact: 'ann@example.test', question: 'Please have Douglas call me about a website', to: undefined }));
  assert.equal(res.status, 200); assert.equal((await res.json()).notified, true);
  assert.equal(bodies[0].to, 'douglastalley1977@gmail.com');
  assert.match(bodies[0].subject, /Ann wants to reach you/);
  assert.equal(db.events[0].emailed, true);
  assert.equal((await h.notify(post({ kind: 'contact_request', question: 'x', to: 'someone@else.test' }))).status, 400, 'extra fields such as a recipient are refused');
});

test('the second similar unanswered question in a day sends one trending alert', async () => {
  const db = fakeDb(), sent = [], store = limiter();
  const h = createAssistantHandlers({ getDb: () => db, getStore: () => store, mail: async m => sent.push(m), env });
  await h.notify(post({ kind: 'unanswered_question', question: 'Do you build Shopify stores?' }));
  const second = await (await h.notify(post({ kind: 'unanswered_question', question: 'Can you build a Shopify store for me?' }))).json();
  assert.equal(second.trending, true); assert.match(sent[1].subject, /Trending question/);
  const third = await (await h.notify(post({ kind: 'unanswered_question', question: 'do you do shopify stores' }))).json();
  assert.equal(third.trending, false, 'only one trending alert per question per day');
  await h.notify(post({ kind: 'unanswered_question', question: 'What is your refund policy?' }));
  assert.equal(sent.length, 4);
});

test('email failure still saves the event and tells the agent honestly', async () => {
  const quiet = console.error; console.error = () => {};
  try {
    const db = fakeDb(), h = createAssistantHandlers({ getDb: () => db, getStore: limiter, mail: async () => { throw new Error('down'); }, env });
    const value = await (await h.notify(post({ kind: 'contact_request', question: 'Call me' }))).json();
    assert.equal(value.notified, false); assert.match(value.message, /next update/); assert.equal(db.events.length, 1);
  } finally { console.error = quiet; }
});

test('question matching ignores filler words, case and punctuation', () => {
  assert(similarQuestions('How much is a website?', 'how much does a website cost'));
  assert(!similarQuestions('How much is a website?', 'Do you do SEO in Bloomington?'));
  assert.deepEqual(questionTokens('The websites!'), ['website']);
});

test('digests run only at noon and 6 pm Indianapolis time, once each, with a secret', async () => {
  assert.equal(localParts(new Date('2026-07-01T16:05:00Z')).hour, 12);
  assert.equal(digestSlot(new Date('2026-07-01T16:05:00Z')), 'noon');
  assert.equal(digestSlot(new Date('2026-07-01T17:05:00Z')), null);
  assert.equal(digestSlot(new Date('2026-01-15T17:05:00Z')), 'noon', 'standard time');
  assert.equal(digestSlot(new Date('2026-01-15T23:10:00Z')), 'evening');
  const sent = [], db = fakeDb(), store = limiter();
  const h = createAssistantHandlers({ getDb: () => db, getStore: () => store, mail: async m => sent.push(m), env, now: () => new Date('2026-07-01T22:03:00Z') });
  const req = auth => new Request('https://legacyai.space/api/owner/digest', { headers: auth ? { authorization: `Bearer ${auth}` } : {} });
  assert.equal((await h.digest(req())).status, 401);
  assert.equal((await (await h.digest(req('cron-secret'))).json()).sent, true);
  assert.equal((await (await h.digest(req('cron-secret'))).json()).skipped, 'Already sent.');
  assert.equal(sent.length, 1); assert.match(sent[0].subject, /6 pm update: quiet/);
  assert.match(sent[0].body, /ELEVENLABS_API_KEY/);
});

test('digest and alert text list real items and never promise anything was sent to visitors', () => {
  const d = composeDigest({ slot: 'noon', since: new Date(0), now: new Date(), events: [{ kind: 'contact_request', channel: 'phone', visitor_name: 'Bo', contact: '555-0100', question: 'Quote for a site', created_at: new Date() }], inquiries: [{ name: 'Cy', email: 'c@x.test', company: '', message: 'Hi there', created_at: new Date() }], visitors: [], conversations: [{ start_time_unix_secs: 0, call_duration_secs: 90, call_summary_title: 'Pricing call' }] });
  assert.match(d.subject, /Noon update: 2 items/);
  for (const text of ['Bo · 555-0100 · phone', 'Cy', 'Pricing call']) assert(d.body.includes(text), text);
  assert.match(composeAlert({ kind: 'unanswered_question', channel: 'web', visitor_name: '', contact: '', question: 'Q?', summary: '', conversation_id: '' }).body, /Only you receive/);
});

test('without a database the owner is still emailed; only logging and trends are skipped', async () => {
  const quiet = console.error; console.error = () => {};
  try {
    const sent = [], down = () => { throw new HttpError(503, 'no database'); };
    const h = createAssistantHandlers({ getDb: down, getStore: down, mail: async m => sent.push(m), env });
    const value = await (await h.notify(post({ kind: 'unanswered_question', question: 'Do you work in Ohio?' }))).json();
    assert.equal(value.notified, true); assert.equal(sent.length, 1);
    const failed = createAssistantHandlers({ getDb: down, getStore: down, mail: async () => { throw new Error('x'); }, env });
    assert.match((await (await failed.notify(post({ kind: 'contact_request', question: 'Call' }))).json()).message, /direct email tool/);
  } finally { console.error = quiet; }
});

import { gatherDigestNotes } from '../lib/digest-notes.js';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

async function seedCapturedRecords(pg) {
  await pg.query(`CREATE TABLE IF NOT EXISTS legacy_owner_documents (id uuid PRIMARY KEY, call_id text NOT NULL, kind text NOT NULL, title text NOT NULL, content text NOT NULL, recipient text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'draft', version integer NOT NULL DEFAULT 1, notified_to text[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz)`);
  await pg.query(`CREATE TABLE IF NOT EXISTS legacy_content_drafts (id uuid PRIMARY KEY, topic text NOT NULL, channel text NOT NULL, angle text NOT NULL DEFAULT '', draft text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'draft', decided_at timestamptz, version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now())`);
  await pg.query(`CREATE TABLE IF NOT EXISTS legacy_review_responses (id uuid PRIMARY KEY, reviewer text NOT NULL DEFAULT '', rating integer, reply text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'draft', approved_at timestamptz, version integer NOT NULL DEFAULT 1, updated_at timestamptz)`);
  await pg.query(`CREATE TABLE IF NOT EXISTS legacy_prospects (id uuid PRIMARY KEY, name text NOT NULL, business text NOT NULL DEFAULT '', phone text NOT NULL DEFAULT '', email text NOT NULL DEFAULT '', note text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'new', reported_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`);
  await pg.query(`CREATE TABLE IF NOT EXISTS legacy_invoices (document uuid PRIMARY KEY, amount_cents integer NOT NULL, due_date date NOT NULL, status text NOT NULL DEFAULT 'open', paid_at timestamptz, last_reminded_at timestamptz, last_due_notice_at timestamptz, job uuid, version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now())`);
  await pg.query(`INSERT INTO legacy_owner_documents(id,call_id,kind,title,content,status) VALUES ('11111111-1111-4111-8111-111111111111','c1','invoice','Kitchen invoice','Labor.','draft')`);
  await pg.query(`INSERT INTO legacy_owner_documents(id,call_id,kind,title,content,status) VALUES ('22222222-2222-4222-8222-222222222222','c2','invoice','Patio invoice','Labor.','sent')`);
  await pg.query(`INSERT INTO legacy_content_drafts(id,topic,channel,status) VALUES ('33333333-3333-4333-8333-333333333333','Fall maintenance','email','draft'), ('44444444-4444-4444-8444-444444444444','Winter prep','email','draft')`);
  await pg.query(`INSERT INTO legacy_content_drafts(id,topic,channel,status,decided_at) VALUES ('55555555-5555-4555-8555-555555555555','Holiday hours','email','approved','2026-07-01T17:00:00Z')`);
  await pg.query(`INSERT INTO legacy_review_responses(id,reviewer,rating,status,approved_at) VALUES ('66666666-6666-4666-8666-666666666666','Ann',5,'approved','2026-07-01T17:30:00Z')`);
  await pg.query(`INSERT INTO legacy_prospects(id,name,status,reported_at) VALUES ('77777777-7777-4777-8777-777777777777','Bob','reported','2026-07-01T18:00:00Z'), ('88888888-8888-4888-8888-888888888888','Sue','reported','2026-07-01T18:10:00Z')`);
  await pg.query(`INSERT INTO legacy_invoices(document,amount_cents,due_date,status) VALUES ('22222222-2222-4222-8222-222222222222',50000,'2026-07-04','open')`);
}

test('digest notes surface every captured-but-unconsumed record', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  try {
    await seedCapturedRecords(pg);
    const since = new Date('2026-07-01T16:00:00Z');
    const notes = await gatherDigestNotes(db, { since, now: new Date('2026-07-01T22:03:00Z') });
    assert.deepEqual(notes, [
      '1 dictated draft awaiting your review: Kitchen invoice',
      '2 content drafts awaiting review; 1 approved since the last update',
      '1 approved review reply ready to paste: Ann',
      '2 prospects reported and ready to review: Sue, Bob',
      '1 open invoice soonest due 2026-07-04 (chase emails 3 days ahead)',
    ]);
  } finally { await pg.close(); }
});

test('missing tables degrade to skipped notes and the digest still sends', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  try {
    assert.deepEqual(await gatherDigestNotes(db, { since: new Date(), now: new Date() }), [], 'no note and no failure when a table never materialized');
    const sent = [], store = limiter();
    const h = createAssistantHandlers({ getDb: () => db, getStore: () => store, mail: async m => sent.push(m), env, fetcher: async () => { throw new Error('no network in tests'); }, now: () => new Date('2026-07-01T22:03:00Z') });
    const result = await (await h.digest(new Request('https://legacyai.space/api/owner/digest?force=1&slot=evening', { headers: { authorization: 'Bearer cron-secret' } }))).json();
    assert.equal(result.sent, true);
    assert.ok(!sent[0].body.includes('dictated draft'), 'absent tables skip their note silently instead of failing the digest');
  } finally { await pg.close(); }
});

test('the owner digest carries the seeded capture notes end to end', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [], store = limiter();
  try {
    await seedCapturedRecords(pg);
    const h = createAssistantHandlers({ getDb: () => db, getStore: () => store, mail: async m => sent.push(m), env, fetcher: async () => { throw new Error('no network in tests'); }, now: () => new Date('2026-07-01T22:03:00Z') });
    const result = await (await h.digest(new Request('https://legacyai.space/api/owner/digest?force=1&slot=evening', { headers: { authorization: 'Bearer cron-secret' } }))).json();
    assert.equal(result.sent, true);
    const body = sent[0].body;
    for (const fragment of ['dictated draft awaiting your review: Kitchen invoice', '2 content drafts awaiting review', 'approved review reply ready to paste: Ann', 'prospects reported and ready to review: Sue, Bob', 'open invoice soonest due 2026-07-04']) {
      assert.ok(body.includes(fragment), fragment);
    }
    assert.match(body, /\nNotes\n/, 'the notes render in their own digest section');
    assert.ok(body.includes('prospects reported and ready to review: Sue, Bob'), 'prospects sort newest first');
  } finally { await pg.close(); }
});
