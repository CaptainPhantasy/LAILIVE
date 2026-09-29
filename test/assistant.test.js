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
