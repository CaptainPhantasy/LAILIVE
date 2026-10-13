import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createOwnerMailer } from '../lib/assistant.js';
import { createFrontdeskHandler, createOwnerTexter, composeFrontdeskMessage, composeFrontdeskText, readFrontdeskMessage, OWNER_ADDRESSES, OWNER_NUMBER, OWNER_VTEXT_ADDRESS } from '../lib/frontdesk.js';

// SignalWire's post_conversation payload as the receptionist sends it. No secret,
// database, mail provider or messaging provider is contacted: every outbound call
// is a local function that records its arguments.
const env = {
  RECEPTIONIST_WEBHOOK_SECRET: 'front-desk-secret',
  OWNER_NOTIFY_WEBHOOK_URL: 'https://hooks.example.test/frontdesk',
  SIGNALWIRE_SPACE_HOST: 'legacyai.signalwire.com',
  SIGNALWIRE_PROJECT_ID: 'project-1234',
  SIGNALWIRE_API_TOKEN: 'messaging-token',
  FRONTDESK_SMS_FROM: '+18123400000',
};
function callPayload(overrides = {}) {
  return {
    action: 'post_conversation', content_type: 'text/swaig', version: '2.0',
    call_id: 'call-abc', conversation_id: 'conv-abc', ai_session_id: 'session-abc', project_id: 'space-1', space_id: 'space-1', app_name: 'legacy-front-desk',
    caller_id_num: '+18125550123', caller_id_name: 'Jane Caller',
    call_start_date: '2026-10-13T14:00:00.000Z', call_answer_date: '2026-10-13T14:00:04.000Z', call_end_date: '2026-10-13T14:03:00.000Z',
    total_input_tokens: 120, total_output_tokens: 340,
    call_log: [{ role: 'system', content: 'Answer the phone.' }, { role: 'assistant', content: 'Legacy AI, how can I help?' }, { role: 'user', content: 'I need a website for my plumbing business.' }],
    swaig_log: [],
    post_prompt_data: { raw: 'Jane called about a new website for her plumbing business. Call her back after 3 pm.', substituted: '', parsed: {} },
    ...overrides,
  };
}
// Fake drizzle handle: answers the handful of statements the assistant store and the
// front desk call store issue. The assistant events table and the call claim table are
// held in memory, with the call id acting as the primary key the real one would use, so a
// repeated or overlapping delivery is decided here the way the database decides it.
function fakeDb() {
  const events = [], calls = new Map();
  return { events, calls, execute: async query => {
    const text = query.queryChunks ? query.queryChunks.map(c => c.value?.join?.('') ?? '').join('?') : String(query.sql || '');
    const params = query.queryChunks ? query.queryChunks.filter(c => !c.value) : [];
    const [first, second] = params;
    if (/CREATE TABLE|CREATE INDEX/.test(text)) return { rows: [] };
    if (/INSERT INTO legacy_frontdesk_calls/.test(text)) {
      if (calls.has(first)) return { rows: [] };
      calls.set(first, { call_id: first, event_id: null, emailed: false, texted: false, delivering: true, claimed_at: new Date(), delivered_at: null });
      return { rows: [{ call_id: first }] };
    }
    if (/SELECT call_id, event_id, emailed, texted FROM legacy_frontdesk_calls/.test(text)) {
      const row = calls.get(first);
      return { rows: row ? [{ call_id: row.call_id, event_id: row.event_id, emailed: row.emailed, texted: row.texted }] : [] };
    }
    if (/UPDATE legacy_frontdesk_calls SET delivering = true/.test(text)) {
      const row = calls.get(first);
      const stranded = Boolean(row) && new Date(row.claimed_at).getTime() <= Date.now() - Number(second) * 1000;
      if (!row || (row.delivering !== false && !stranded)) return { rows: [] };
      row.delivering = true; row.claimed_at = new Date();
      return { rows: [{ call_id: first }] };
    }
    if (/UPDATE legacy_frontdesk_calls SET event_id/.test(text)) { const row = calls.get(second); if (row) row.event_id = first; return { rows: [] }; }
    if (/UPDATE legacy_frontdesk_calls SET delivering = false/.test(text)) {
      const [emailed, texted, , callId] = params, row = calls.get(callId);
      if (row) { row.delivering = false; row.emailed ||= emailed === true; row.texted ||= texted === true; if (row.emailed) row.delivered_at ||= new Date(); }
      return { rows: [] };
    }
    if (/INSERT INTO legacy_assistant_events/.test(text)) { const [id, kind, channel, visitor_name, contact, question, summary, conversation_id] = params; const row = { id, kind, channel, visitor_name, contact, question, summary, conversation_id, emailed: false, created_at: new Date().toISOString() }; events.push(row); return { rows: [row] }; }
    if (/UPDATE legacy_assistant_events/.test(text)) { events.find(e => e.id === params[0]).emailed = true; return { rows: [] }; }
    if (/FROM legacy_assistant_events/.test(text)) return { rows: [...events] };
    return { rows: [] };
  } };
}
// The real mailer, so the shape sent to the owner webhook is exercised, with the
// network replaced by a recorder.
function recorder() { const sent = []; return { sent, fn: async value => { sent.push(value); return true; } }; }
function mailer(bodies) {
  return createOwnerMailer({ env, fetcher: async (url, init) => { bodies.push(JSON.parse(init.body)); return new Response('ok'); } });
}
function request(body, { method = 'POST', secret = 'header', url, headers = {} } = {}) {
  const built = new Request('https://legacyai.space/api/frontdesk/message', {
    method,
    headers: { ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...(secret === 'header' ? { 'x-frontdesk-secret': env.RECEPTIONIST_WEBHOOK_SECRET } : {}), ...headers },
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  // The platform hands the handler a URL that still carries the Basic credentials
  // SignalWire embeds; the Request constructor refuses to build such a URL itself.
  if (url) Object.defineProperty(built, 'url', { value: url });
  return built;
}
function handler({ db = fakeDb(), bodies = [], texts = [], ...rest } = {}) {
  return { db, bodies, texts, h: createFrontdeskHandler({ getDb: () => db, mail: mailer(bodies), text: async value => { texts.push(value); return true; }, env, now: () => new Date('2026-10-13T18:05:00.000Z'), ...rest }) };
}

test('only POST with the shared secret is accepted, and nothing is sent before that', async () => {
  const { db, bodies, texts, h } = handler();
  assert.equal((await h.message(request(null, { method: 'GET' }))).status, 405);
  for (const secret of [false, 'wrong', 'front-desk-secre']) assert.equal((await h.message(request(callPayload(), { secret: secret === false ? false : secret }))).status, 401);
  assert.equal(db.events.length, 0); assert.equal(bodies.length, 0); assert.equal(texts.length, 0);
});

test('the secret is accepted from the URL, the header and Basic authorization', async () => {
  const address = secret => `https://frontdesk:${secret}@legacyai.space/api/frontdesk/message`;
  const plain = () => createFrontdeskHandler({ getDb: () => fakeDb(), mail: async () => true, text: async () => true, env });
  const expecting = secret => createFrontdeskHandler({ getDb: () => fakeDb(), mail: async () => true, text: async () => true, env: { ...env, RECEPTIONIST_WEBHOOK_SECRET: secret } });
  assert.equal((await plain().message(request(callPayload(), { secret: false, url: address(env.RECEPTIONIST_WEBHOOK_SECRET) }))).status, 200);
  assert.equal((await plain().message(request(callPayload(), { secret: false, url: address('wrong-secret') }))).status, 401, 'a wrong embedded secret is refused');
  assert.equal((await plain().message(request(callPayload(), { secret: false, url: address('') }))).status, 401, 'a URL without credentials carries no secret');
  // Percent-encoded credentials are decoded before the comparison.
  assert.equal((await expecting('s3cret@x').message(request(callPayload(), { secret: false, url: address('s3cret%40x') }))).status, 200);
  assert.equal((await expecting('s3cret@x').message(request(callPayload(), { secret: false, url: address('s3cret%40') }))).status, 401);
  assert.equal((await plain().message(request(callPayload(), { secret: false, headers: { authorization: `Basic ${Buffer.from(`frontdesk:${env.RECEPTIONIST_WEBHOOK_SECRET}`).toString('base64')}` } }))).status, 200);
  assert.equal((await plain().message(request(callPayload(), { secret: false, headers: { authorization: 'Basic not-base64' } }))).status, 401);
});

test('a call is stored as a phone message, emailed to both owner addresses and texted to the owner', async () => {
  const { db, bodies, texts, h } = handler();
  // A payload cannot name a recipient: the two owner addresses are the only ones used.
  const response = await h.message(request(callPayload({ to: 'someone.else@example.test', recipient: 'someone.else@example.test' })));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true, stored: true, emailed: [...OWNER_ADDRESSES], texted: true, textVia: 'signalwire', duplicate: false, callId: 'call-abc',
    message: 'Douglas was emailed and texted about this call.',
  });
  const row = db.events[0];
  assert.equal(row.kind, 'contact_request'); assert.equal(row.channel, 'phone');
  assert.equal(row.contact, '+18125550123'); assert.equal(row.visitor_name, 'Jane Caller');
  assert.equal(row.summary, 'Jane called about a new website for her plumbing business. Call her back after 3 pm.');
  assert.equal(row.conversation_id, 'call-abc'); assert.equal(row.question, '', 'the digest shows the summary, not a stray question');
  assert.equal(row.emailed, true);
  assert.equal(bodies.length, 3, 'the two owner addresses and the gateway');
  assert.deepEqual(bodies.map(b => b.to), [...OWNER_ADDRESSES, OWNER_VTEXT_ADDRESS]);
  assert.match(bodies[0].subject, /Front desk message/);
  assert.match(bodies[0].subject, /\+18125550123/);
  assert.match(bodies[0].subject, /Jane Caller/);
  assert.match(bodies[0].body, /Jane called about a new website for her plumbing business/);
  assert.match(bodies[0].body, /Caller: I need a website for my plumbing business\./);
  assert.match(bodies[0].body, /Front desk: Legacy AI, how can I help\?/);
  assert.match(bodies[0].body, /Call id: call-abc/);
  assert.match(bodies[0].body, /Only you receive these messages/);
  assert.equal(bodies[2].to, OWNER_VTEXT_ADDRESS);
  assert.equal(bodies[2].subject, 'Front desk message');
  assert.equal(bodies[2].body, composeFrontdeskText(readFrontdeskMessage(callPayload())), 'the gateway carries the short text, not the full composed message');
  assert.equal(texts.length, 1);
  assert.equal(texts[0].to, OWNER_NUMBER);
  assert.match(texts[0].body, /^Front desk message from \+18125550123 \(Jane Caller\)\. Jane called about a new website/);
});

test('a repeated report for the same call is acknowledged without emailing or texting again', async () => {
  const { db, bodies, texts, h } = handler();
  await h.message(request(callPayload()));
  const repeat = await (await h.message(request(callPayload()))).json();
  assert.deepEqual(repeat, { ok: true, duplicate: true, stored: false, emailed: [], texted: false, callId: 'call-abc', message: 'This call was already sent to Douglas; nothing was sent again.' });
  assert.equal(db.events.length, 1, 'the repeated report is not stored twice');
  assert.equal(bodies.length, 3); assert.equal(texts.length, 1);
  assert.equal(bodies.filter(b => b.to === OWNER_VTEXT_ADDRESS).length, 1, 'the gateway is mailed once, for the first delivery');
  // A different call still gets through.
  assert.equal((await h.message(request(callPayload({ call_id: 'call-def' })))).status, 200);
  assert.equal(db.events.length, 2); assert.equal(bodies.length, 6);
});

test('a stored call whose notification failed is retried instead of being swallowed', async () => {
  const db = fakeDb(), bodies = [], texts = [];
  const first = createFrontdeskHandler({ getDb: () => db, mail: async () => { throw new Error('mail provider down'); }, text: async () => { throw new Error('messaging down'); }, env, now: () => new Date('2026-10-13T18:05:00.000Z') });
  const quiet = console.error; console.error = () => {};
  try {
    const failed = await (await first.message(request(callPayload()))).json();
    assert.deepEqual(failed, { ok: false, stored: true, emailed: [], emailFailed: [...OWNER_ADDRESSES], texted: false, textVia: 'none', textError: 'messaging down', duplicate: false, callId: 'call-abc', message: 'This call was not sent to Douglas. Check the front desk configuration.' });
    assert.equal(db.events[0].emailed, false);
  } finally { console.error = quiet; }
  const second = handler({ db, bodies, texts });
  const retried = await (await second.h.message(request(callPayload()))).json();
  assert.equal(retried.duplicate, false); assert.equal(retried.texted, true); assert.equal(retried.textVia, 'signalwire');
  assert.equal(bodies.length, 3); assert.equal(texts.length, 1);
  assert.equal(db.events.length, 1, 'the retry records the delivery on the row the first attempt stored');
  assert.equal(db.events[0].emailed, true);
  // With the delivery recorded, the next report for the same call is not sent again.
  assert.equal((await (await second.h.message(request(callPayload()))).json()).duplicate, true);
  assert.equal(bodies.length, 3); assert.equal(texts.length, 1);
});

test('texting the owner is attempted even when the email cannot be delivered, and every failure is reported in the body', async () => {
  const quiet = console.error; console.error = () => {};
  try {
    const texts = [];
    const noMail = createFrontdeskHandler({ getDb: () => fakeDb(), mail: async () => { throw new Error('webhook down'); }, text: async value => { texts.push(value); return true; }, env });
    const response = await noMail.message(request(callPayload()));
    const body = await response.json();
    assert.equal(response.status, 200, 'a notification failure is never a 5xx');
    assert.deepEqual(body.emailed, []); assert.deepEqual(body.emailFailed, [...OWNER_ADDRESSES]);
    assert.equal(body.texted, true); assert.equal(body.ok, false);
    assert.match(body.message, /texted about this call; the email did not go out/);
    assert.equal(texts.length, 1);
    // Missing SignalWire settings keep the email working and name the missing variable.
    const bodies = [], sent = [];
    const h = createFrontdeskHandler({ getDb: () => fakeDb(), mail: mailer(bodies), text: createOwnerTexter({ env: { ...env, FRONTDESK_SMS_FROM: '' }, fetcher: async () => { sent.push(1); return new Response('ok'); } }), env, now: () => new Date() });
    const value = await (await h.message(request(callPayload()))).json();
    assert.equal(value.texted, true, 'the gateway mail carries the text while SignalWire messaging is unconfigured'); assert.equal(value.textVia, 'vtext');
    assert.match(value.textError, /FRONTDESK_SMS_FROM/);
    assert.equal(value.ok, true); assert.equal(bodies.length, 3); assert.equal(sent.length, 0, 'nothing is sent without the sender number');
    assert.equal(bodies[2].to, OWNER_VTEXT_ADDRESS);
    // A refused send is reported rather than thrown, and the gateway still delivers the text.
    const refused = createFrontdeskHandler({ getDb: () => fakeDb(), mail: async () => true, text: createOwnerTexter({ env, fetcher: async () => new Response('nope', { status: 401 }) }), env });
    const refusedBody = await (await refused.message(request(callPayload()))).json();
    assert.equal(refusedBody.texted, true); assert.equal(refusedBody.textVia, 'vtext');
    assert.match(refusedBody.textError, /SignalWire messaging returned 401/);
  } finally { console.error = quiet; }
});

test('a missing or broken database never stops the owner being told', async () => {
  const quiet = console.error; console.error = () => {};
  try {
    const bodies = [], texts = [];
    for (const getDb of [() => { throw new Error('The inquiry service is not connected yet.'); }, () => ({ execute: async () => { throw new Error('connection refused'); } })]) {
      const h = createFrontdeskHandler({ getDb, mail: mailer(bodies), text: async value => { texts.push(value); return true; }, env, now: () => new Date() });
      const response = await h.message(request(callPayload()));
      const body = await response.json();
      assert.equal(response.status, 200); assert.equal(body.stored, false); assert.equal(body.texted, true); assert.equal(body.textVia, 'signalwire');
      assert(body.storageError, 'the storage failure is named in the response');
    }
    assert.equal(bodies.length, 6); assert.equal(texts.length, 2);
    assert.equal(bodies.filter(b => b.to === OWNER_VTEXT_ADDRESS).length, 2, 'the gateway mail still goes out when the database is unreachable');
  } finally { console.error = quiet; }
});

test('the payload is bounded: huge transcripts and summaries are cut, bad input is refused', async () => {
  const { bodies, h } = handler();
  const many = readFrontdeskMessage(callPayload({ call_log: [...Array(400).keys()].map(i => ({ role: 'user', content: `note ${i}` })) }), new Date());
  assert.equal(many.transcript.length, 200);
  assert.equal(many.transcriptTruncated, true);
  const heavy = readFrontdeskMessage(callPayload({ call_log: [...Array(400).keys()].map(i => ({ role: 'user', content: `${i} ${'x'.repeat(1500)}` })), post_prompt_data: { raw: 'y'.repeat(9000) } }), new Date());
  assert(heavy.transcript.length < 200, 'the character budget is reached before the turn limit');
  assert.equal(heavy.transcriptTruncated, true);
  assert.equal(heavy.summary.length, 2000);
  assert(heavy.transcript.reduce((n, turn) => n + turn.content.length, 0) <= 22000);
  // Large enough to hit both transcript caps, still inside the request size limit.
  const long = await (await h.message(request({ ...callPayload(), call_log: [...Array(250).keys()].map(i => ({ role: 'user', content: `${i} ${'x'.repeat(120)}` })) }))).json();
  assert.equal(long.ok, true);
  assert(bodies[0].body.includes('cut short'));
  assert(bodies[0].body.length < 30000, 'a huge payload cannot blow up the message');
  const short = readFrontdeskMessage(callPayload({ call_log: [{ role: 'user', content: 'One turn.' }] }));
  assert.equal(short.transcript.length, 1); assert.equal(short.transcriptTruncated, false);
  assert.equal((await h.message(request({ ...callPayload(), caller_id_num: 'z'.repeat(400), caller_id_name: 42, total_input_tokens: 'NaN', call_start_date: 'not a date' }))).status, 200);
  assert.equal(readFrontdeskMessage({ caller_id_num: 'z'.repeat(400), call_start_date: 'not a date' }).callerNumber.length, 40);
  assert.equal(readFrontdeskMessage(null).summary, '');
  const junk = readFrontdeskMessage(callPayload({ call_log: [{ role: 'operator', content: 'drop me' }, { role: 'user', content: '   ' }, { role: 'user' }, { role: 'USER', content: 'keep\u0007me' }] }));
  assert.deepEqual(junk.transcript, [{ role: 'user', content: 'keep me' }]);
  assert.equal((await h.message(request('not json'))).status, 400);
  assert.equal((await h.message(request({ ...callPayload(), pad: 'x'.repeat(300000) }))).status, 413);
});

test('the text is sent through the SignalWire messaging API with the project credentials', async () => {
  let seen;
  const texter = createOwnerTexter({ env, fetcher: async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ sid: 'SM1' }), { status: 201 }); } });
  assert.equal(await texter({ to: OWNER_NUMBER, body: 'Front desk message from +18125550123.' }), true);
  assert.equal(seen.url, 'https://legacyai.signalwire.com/api/laml/2010-04-01/Accounts/project-1234/Messages.json');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.Authorization, `Basic ${Buffer.from('project-1234:messaging-token').toString('base64')}`);
  assert.equal(seen.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(seen.init.body.toString(), new URLSearchParams({ To: OWNER_NUMBER, From: '+18123400000', Body: 'Front desk message from +18125550123.' }).toString());
  await assert.rejects(createOwnerTexter({ env: { ...env, SIGNALWIRE_API_TOKEN: '' }, fetcher: async () => new Response('ok') })({ to: OWNER_NUMBER, body: 'x' }), /SIGNALWIRE_API_TOKEN/);
  assert.equal(await createOwnerTexter({ env: { ...env, SIGNALWIRE_SPACE_HOST: 'https://legacyai.signalwire.com/' }, fetcher: async url => { assert.equal(url, seen.url); return new Response('ok'); } })({ to: OWNER_NUMBER, body: 'x' }), true);
});

test('the text message stays short and the email lists the call facts', () => {
  const fresh = readFrontdeskMessage(callPayload());
  assert.match(composeFrontdeskText(fresh), /^Front desk message from \+18125550123 \(Jane Caller\)\. Jane called about a new website/);
  assert(composeFrontdeskText(readFrontdeskMessage(callPayload({ post_prompt_data: { raw: 'word '.repeat(400) } }))).length < 420);
  assert.equal(composeFrontdeskText(readFrontdeskMessage(callPayload({ post_prompt_data: { raw: '' }, caller_id_num: '', caller_id_name: '' }))), 'Front desk message from an unknown number.');
  const bare = composeFrontdeskMessage(readFrontdeskMessage(callPayload({ call_log: [], post_prompt_data: {} })));
  assert.match(bare.subject, /Front desk message from \+18125550123/);
  assert.match(bare.body, /\(This call arrived without a summary\.\)/);
  assert.match(bare.body, /\(This call arrived without a transcript\.\)/);
  assert.match(composeFrontdeskMessage(readFrontdeskMessage({})).subject, /Front desk message from an unknown number/);
});

test('the real events table accepts a front desk row and suppresses the repeat', async t => {
  const client = new PGlite();
  t.after(() => client.close());
  await client.exec(await readFile(new URL('../migrations/0003_assistant_events.sql', import.meta.url), 'utf8'));
  const db = drizzle(client), bodies = [], texts = [];
  const h = createFrontdeskHandler({ getDb: () => db, mail: mailer(bodies), text: async value => { texts.push(value); return true; }, env, now: () => new Date() });
  assert.equal((await h.message(request(callPayload()))).status, 200);
  const rows = (await client.query('SELECT kind, channel, visitor_name, contact, question, summary, conversation_id, emailed FROM legacy_assistant_events')).rows;
  assert.deepEqual(rows, [{
    kind: 'contact_request', channel: 'phone', visitor_name: 'Jane Caller', contact: '+18125550123', question: '',
    summary: 'Jane called about a new website for her plumbing business. Call her back after 3 pm.', conversation_id: 'call-abc', emailed: true,
  }]);
  const repeat = await (await h.message(request(callPayload()))).json();
  assert.equal(repeat.duplicate, true);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM legacy_assistant_events')).rows[0].n, 1);
  assert.equal(bodies.length, 3); assert.equal(texts.length, 1);
});

// The review fixes. Each test below fails against the code as merged.

// A body that arrives in chunks with no content-length header, the way a platform hands
// one over: only reading the stream can enforce the request cap. `state.pulled` counts the
// chunks the handler actually took off the stream.
function streamRequest(pieces) {
  const state = { pulled: 0 };
  const encoder = new TextEncoder();
  const request = new Request('https://legacyai.space/api/frontdesk/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-frontdesk-secret': env.RECEPTIONIST_WEBHOOK_SECRET },
    duplex: 'half',
    body: new ReadableStream({ pull(controller) { if (state.pulled >= pieces.length) return controller.close(); controller.enqueue(encoder.encode(pieces[state.pulled++])); } }),
  });
  return { request, state };
}
// A real database with both assistant migrations applied. The handler creates its own call
// table on first use as well, so running it here proves the two agree.
async function frontdeskSchema(client) {
  for (const file of ['0003_assistant_events.sql', '0004_frontdesk_calls.sql']) await client.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
}
async function seededDatabase(t) {
  const client = new PGlite();
  t.after(() => client.close());
  await frontdeskSchema(client);
  return client;
}

test('the Vercel route exports a callable fetch handler, not the map of route names', async () => {
  const route = await import('../api/frontdesk/message.js');
  assert.equal(typeof route.default, 'object');
  assert.equal(typeof route.default.fetch, 'function', 'Vercel calls fetch itself, so it must be the handler rather than the object keyed by route name');
  assert.equal(route.default.fetch.length, 1, 'the exported handler is the one that takes a request');
});

test('only a finished call is reported: a fetch at call start is ignored and cannot swallow the real report', async () => {
  const quiet = console.error; console.error = () => {};
  try {
    const { db, bodies, texts, h } = handler();
    const fetched = await (await h.message(request(callPayload({ action: 'fetch_conversation' })))).json();
    assert.deepEqual(fetched, {
      ok: true, ignored: true, action: 'fetch_conversation', stored: false, emailed: [], texted: false, duplicate: false, callId: 'call-abc',
      message: "A 'fetch_conversation' request is not a finished call, so nothing was sent to Douglas.",
    });
    assert.equal(db.events.length, 0, 'a fetch is not stored as a call');
    assert.equal(db.calls.size, 0, 'a fetch does not claim the call');
    assert.equal(bodies.length, 0); assert.equal(texts.length, 0);
    // The finished report for the same call still goes out, and is not mistaken for a repeat.
    const finished = await (await h.message(request(callPayload()))).json();
    assert.equal(finished.duplicate, false);
    assert.deepEqual(finished.emailed, [...OWNER_ADDRESSES]); assert.equal(finished.texted, true); assert.equal(finished.textVia, 'signalwire');
    assert.equal(db.events.length, 1); assert.equal(bodies.length, 3); assert.equal(texts.length, 1);
    // Every other action is named in the response and nothing is sent for it.
    const other = await (await h.message(request(callPayload({ action: 'post_prompt' })))).json();
    assert.equal(other.ignored, true); assert.equal(other.action, 'post_prompt');
    assert.equal(other.texted, false); assert.deepEqual(other.emailed, []);
    const unnamed = await (await h.message(request(callPayload({ action: undefined })))).json();
    assert.equal(unnamed.ignored, true); assert.equal(unnamed.action, '');
    assert.match(unnamed.message, /named no action/);
    assert.equal(db.events.length, 1); assert.equal(bodies.length, 3); assert.equal(texts.length, 1);
    assert.equal(bodies.filter(b => b.to === OWNER_VTEXT_ADDRESS).length, 1, 'the gateway is mailed once, for the finished call only');
  } finally { console.error = quiet; }
});

test('the documented caller_id_number is read, and the older caller_id_num still works', async () => {
  const { db, bodies, texts, h } = handler();
  const documented = callPayload({ caller_id_number: '+18125550999', caller_id_num: undefined });
  assert.equal((await h.message(request(documented))).status, 200);
  assert.equal(db.events[0].contact, '+18125550999', 'the stored contact carries the number');
  assert.match(bodies[0].subject, /\+18125550999/);
  assert.match(bodies[0].body, /Caller: \+18125550999/);
  assert.match(texts[0].body, /^Front desk message from \+18125550999/);
  // The documented field wins when a report carries both, and the older name is still read.
  assert.equal(readFrontdeskMessage({ caller_id_number: '+18125550999', caller_id_num: '+18120000000' }).callerNumber, '+18125550999');
  assert.equal(readFrontdeskMessage({ caller_id_num: '+18125550123' }).callerNumber, '+18125550123');
  assert.equal(readFrontdeskMessage({ caller_id_number: 42, caller_id_num: '+18125550123' }).callerNumber, '+18125550123');
  assert.equal(readFrontdeskMessage({ caller_id_number: 'z'.repeat(400) }).callerNumber.length, 40);
});

test('call times sent as Unix microseconds become real call times', () => {
  const start = Date.parse('2026-10-13T14:00:00.000Z') * 1000;
  const record = readFrontdeskMessage(callPayload({ call_start_date: start, call_answer_date: start + 4000000, call_end_date: start + 180000000 }));
  assert.equal(record.startedAt, '2026-10-13T14:00:00.000Z');
  assert.equal(record.answeredAt, '2026-10-13T14:00:04.000Z');
  assert.equal(record.endedAt, '2026-10-13T14:03:00.000Z');
  const message = composeFrontdeskMessage(record);
  assert.match(message.body, /Call started: Oct 13, 10:00 AM/);
  assert.match(message.body, /Call ended: Oct 13, 10:03 AM/);
  // Milliseconds and seconds are read too, and junk is still dropped.
  assert.equal(readFrontdeskMessage(callPayload({ call_start_date: 1791900000000 })).startedAt, '2026-10-13T14:00:00.000Z');
  assert.equal(readFrontdeskMessage(callPayload({ call_start_date: 1791900000 })).startedAt, '2026-10-13T14:00:00.000Z');
  assert.equal(readFrontdeskMessage(callPayload({ call_start_date: 'not a date' })).startedAt, '');
  assert.equal(readFrontdeskMessage(callPayload({ call_end_date: 0 })).endedAt, '');
});

test('a caller name or number with a line break cannot break the email subject', async () => {
  const { bodies, texts, h } = handler();
  const inject = callPayload({
    caller_id_number: '+18125550123\r\nBcc: someone.else@example.test',
    caller_id_name: 'Jane Caller\r\nX-Forwarded-To: someone.else@example.test',
  });
  assert.equal((await h.message(request(inject))).status, 200);
  assert.equal(bodies.length, 3);
  // Only the two owner addresses carry the composed subject; the gateway mail carries the
  // short text, which must stay on one line as well.
  for (const sent of bodies.slice(0, OWNER_ADDRESSES.length)) {
    assert(!/[\r\n]/.test(sent.subject), 'the subject stays a single header value');
    assert.match(sent.subject, /^Front desk message from \+18125550123 Bcc: someone\.else@example\. \(Jane Caller X-Forwarded-To: someone\.else@example\.test\)$/);
  }
  assert.equal(bodies[2].to, OWNER_VTEXT_ADDRESS);
  assert(!/[\r\n]/.test(bodies[2].body), 'the gateway copy is one line');
  assert(!/[\r\n]/.test(texts[0].body), 'the text message is one line');
  // The stored row keeps the caller's own text; only the composed subject and body lines are
  // collapsed onto one line.
  assert.match(bodies[0].body, /^Caller: \+18125550123 Bcc: someone\.else@example\. \(Jane Caller X-Forwarded-To: someone\.else@example\.test\)$/m);
});

test('the transcript spends only the remaining budget and stops at the documented limit', () => {
  const turn = size => ({ role: 'user', content: 'x'.repeat(size) });
  const total = record => record.transcript.reduce((sum, entry) => sum + entry.content.length, 0);
  // 19,999 characters already spent: the next 2,000-character turn may only add the 1 left.
  const nearly = readFrontdeskMessage(callPayload({ call_log: [...Array(9).keys()].map(() => turn(2000)).concat([turn(1999), turn(2000)]) }));
  assert.equal(total(nearly), 20000, 'the transcript stops at the documented 20,000 characters');
  assert.equal(nearly.transcriptTruncated, true);
  assert.equal(nearly.transcript.at(-1).content.length, 1, 'the last turn is cut to what is left of the budget');
  // Exactly the budget is not a truncation; one character more is.
  const exact = readFrontdeskMessage(callPayload({ call_log: [...Array(10).keys()].map(() => turn(2000)) }));
  assert.equal(total(exact), 20000); assert.equal(exact.transcriptTruncated, false);
  const over = readFrontdeskMessage(callPayload({ call_log: [...Array(11).keys()].map(() => turn(2000)) }));
  assert.equal(total(over), 20000); assert.equal(over.transcriptTruncated, true);
  assert.equal(over.transcript.length, 10, 'a turn with no budget left is dropped rather than stored empty');
});

test('the request cap is counted in bytes while the body is read, and reading stops at the cap', async () => {
  const { bodies, texts, h } = handler();
  // 140,000 two-byte characters: inside the cap counted as string characters, well over it
  // counted as bytes.
  const wide = JSON.stringify({ ...callPayload(), pad: 'é'.repeat(140000) });
  assert(wide.length < 262144 && Buffer.byteLength(wide) > 262144, 'the payload is under the cap in characters and over it in bytes');
  assert.equal(streamRequest([wide]).request.headers.get('content-length'), null, 'a streamed body carries no content-length');
  assert.equal((await h.message(streamRequest([wide]).request)).status, 413);
  assert.equal(bodies.length, 0); assert.equal(texts.length, 0);
  // A body far over the cap is not read to the end: the cap is passed on the ninth chunk.
  const huge = streamRequest(Array.from({ length: 20 }, () => 'x'.repeat(32768)));
  assert.equal((await h.message(huge.request)).status, 413);
  assert(huge.state.pulled < 20, `the read stopped at the cap instead of pulling every chunk (pulled ${huge.state.pulled} of 20)`);
  // A body inside the cap in bytes is read whole and parsed.
  assert.equal((await h.message(streamRequest([JSON.stringify(callPayload())]).request)).status, 200);
  assert.equal(bodies.length, 3); assert.equal(texts.length, 1);
});

test('a report is delivered even when more than 200 stored events are in the duplicate window', async t => {
  const client = await seededDatabase(t);
  const db = drizzle(client), bodies = [], texts = [];
  // 250 escalations inside the seven-day window and all older than this call: a lookup that
  // reads a capped, oldest-first page of that window never sees the call itself.
  await client.exec(`INSERT INTO legacy_assistant_events (id, kind, channel, question, created_at) SELECT gen_random_uuid(), 'unanswered_question', 'web', 'question ' || i, now() - interval '1 hour' FROM generate_series(1, 250) AS i`);
  const h = createFrontdeskHandler({ getDb: () => db, mail: mailer(bodies), text: async value => { texts.push(value); return true; }, env, now: () => new Date() });
  assert.equal((await h.message(request(callPayload()))).status, 200);
  const repeat = await (await h.message(request(callPayload()))).json();
  assert.equal(repeat.duplicate, true, 'the call id is matched directly, however many other events are stored');
  assert.equal(bodies.length, 3, 'the repeat emailed nobody and did not reach the gateway'); assert.equal(texts.length, 1);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM legacy_assistant_events WHERE conversation_id = 'call-abc'")).rows[0].n, 1);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM legacy_frontdesk_calls')).rows[0].n, 1);
});

test('two overlapping deliveries of one call notify once', async t => {
  const client = await seededDatabase(t);
  const db = drizzle(client), bodies = [], texts = [];
  let release, sending;
  const blocked = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { sending = resolve; });
  const slow = createFrontdeskHandler({ getDb: () => db, mail: async value => { bodies.push(value); sending(); await blocked; return true; }, text: async value => { texts.push(value); return true; }, env, now: () => new Date() });
  const fast = createFrontdeskHandler({ getDb: () => db, mail: mailer(bodies), text: async value => { texts.push(value); return true; }, env, now: () => new Date() });
  const handling = slow.message(request(callPayload()));
  await started;
  assert.equal(bodies.length, 3, 'the first delivery is emailing both addresses and mailing the gateway');
  const overlapping = await (await fast.message(request(callPayload()))).json();
  assert.equal(overlapping.inFlight, true, 'the overlapping delivery reports that the call is already being sent');
  assert.equal(overlapping.duplicate, false);
  assert.deepEqual(overlapping.emailed, []); assert.equal(overlapping.texted, false);
  assert.equal(bodies.length, 3, 'the overlapping delivery emailed nobody'); assert.equal(texts.length, 1, 'and texted nobody');
  release();
  const delivered = await (await handling).json();
  assert.equal(delivered.duplicate, false); assert.deepEqual(delivered.emailed, [...OWNER_ADDRESSES]); assert.equal(delivered.texted, true);
  assert.equal(bodies.length, 3); assert.equal(texts.length, 1);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM legacy_assistant_events')).rows[0].n, 1, 'the call is stored once');
  // A later report for the same call is a repeat, and sends nothing.
  const repeat = await (await fast.message(request(callPayload()))).json();
  assert.equal(repeat.duplicate, true);
  assert.equal(bodies.length, 3); assert.equal(texts.length, 1);
});

test('a delivery killed mid-flight is taken over, and a claim that is still running is left alone', async t => {
  const client = await seededDatabase(t);
  const db = drizzle(client), bodies = [], texts = [];
  const h = createFrontdeskHandler({ getDb: () => db, mail: mailer(bodies), text: async value => { texts.push(value); return true; }, env, now: () => new Date() });
  // A claim left running by a function that died six minutes ago is taken over, and the
  // row it never got to store is stored by this delivery.
  await client.exec(`INSERT INTO legacy_frontdesk_calls (call_id, delivering, claimed_at) VALUES ('call-abc', true, now() - interval '6 minutes')`);
  const taken = await (await h.message(request(callPayload()))).json();
  assert.equal(taken.duplicate, false); assert.equal(taken.stored, true);
  assert.deepEqual(taken.emailed, [...OWNER_ADDRESSES]); assert.equal(taken.texted, true);
  assert.equal(bodies.length, 3); assert.equal(texts.length, 1);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM legacy_assistant_events')).rows[0].n, 1);
  // A claim that is still fresh belongs to the delivery that is running.
  await client.exec(`UPDATE legacy_frontdesk_calls SET emailed = false, texted = false, delivering = true, claimed_at = now() WHERE call_id = 'call-abc'`);
  const held = await (await h.message(request(callPayload()))).json();
  assert.equal(held.inFlight, true); assert.equal(held.duplicate, false);
  assert.deepEqual(held.emailed, []); assert.equal(held.texted, false);
  assert.equal(bodies.length, 3); assert.equal(texts.length, 1);
});

test('the two emails and the text are all started before any of them finishes', async () => {
  const order = [];
  const step = async name => { order.push(`start ${name}`); await new Promise(resolve => setImmediate(resolve)); order.push(`end ${name}`); return true; };
  const h = createFrontdeskHandler({
    getDb: () => fakeDb(),
    mail: async ({ to }) => step(to),
    text: async () => step('text'),
    env, now: () => new Date('2026-10-13T18:05:00.000Z'),
  });
  const body = await (await h.message(request(callPayload()))).json();
  assert.deepEqual(body.emailed, [...OWNER_ADDRESSES]); assert.equal(body.texted, true);
  // Sequential sends would show 'end email one' before 'start email two' and 'start text'.
  assert.deepEqual(order.slice(0, 3), [`start ${OWNER_ADDRESSES[0]}`, `start ${OWNER_ADDRESSES[1]}`, 'start text']);
  assert(order.indexOf('start text') < order.indexOf(`end ${OWNER_ADDRESSES[0]}`));
  assert(order.indexOf(`start ${OWNER_ADDRESSES[1]}`) < order.indexOf(`end ${OWNER_ADDRESSES[0]}`));
});

test('a call whose email failed is not recorded as done, so the email is retried and the text is not sent twice', async () => {
  const db = fakeDb(), bodies = [], texts = [];
  const quiet = console.error; console.error = () => {};
  try {
    const textOnly = createFrontdeskHandler({ getDb: () => db, mail: async () => { throw new Error('webhook down'); }, text: async value => { texts.push(value); return true; }, env, now: () => new Date('2026-10-13T18:05:00.000Z') });
    const failed = await (await textOnly.message(request(callPayload()))).json();
    assert.deepEqual(failed.emailed, []); assert.equal(failed.texted, true); assert.equal(failed.ok, false);
    assert.equal(db.events[0].emailed, false, 'the stored row does not claim Douglas was emailed');
    assert.equal(db.calls.get('call-abc').emailed, false, 'and neither does the claim row');
    assert.equal(db.calls.get('call-abc').texted, true);
    // A later report for the same call sends the email the owner is owed, and does not text
    // him a second time.
    const second = handler({ db, bodies, texts });
    const retried = await (await second.h.message(request(callPayload()))).json();
    assert.equal(retried.duplicate, false);
    assert.deepEqual(retried.emailed, [...OWNER_ADDRESSES]);
    assert.equal(retried.textVia, 'none', 'nothing is sent on the text channel again');
    assert.equal(bodies.length, 2, 'the email was retried'); assert.equal(texts.length, 1, 'the text went out once');
    assert.equal(db.events.length, 1); assert.equal(db.events[0].emailed, true);
    assert.equal(db.calls.get('call-abc').emailed, true);
    // With both channels delivered, the next report for this call is a repeat.
    const repeat = await (await second.h.message(request(callPayload()))).json();
    assert.equal(repeat.duplicate, true);
    assert.equal(bodies.length, 2); assert.equal(texts.length, 1);
  } finally { console.error = quiet; }
});

// The carrier email-to-text gateway. While SignalWire messaging is refused, the short text
// also goes to Douglas by mail through Verizon's gateway, which turns it into an SMS.

test('the gateway address is derived from the owner number', () => {
  assert.equal(OWNER_NUMBER, '+18123405761');
  assert.equal(OWNER_VTEXT_ADDRESS, '8123405761@vtext.com', 'the country code is dropped and the gateway host appended');
});

test('both owner addresses receive the full message and the gateway receives the short one', async () => {
  const { bodies, texts, h } = handler();
  const body = await (await h.message(request(callPayload()))).json();
  assert.equal(body.textVia, 'signalwire');
  assert.equal(bodies.length, 3, 'two owner mails and one gateway mail');
  assert.deepEqual(bodies.map(sent => sent.to), [...OWNER_ADDRESSES, OWNER_VTEXT_ADDRESS], 'the two owner addresses are unchanged and the gateway is added');
  const full = composeFrontdeskMessage(readFrontdeskMessage(callPayload(), new Date('2026-10-13T18:05:00.000Z')));
  for (const to of OWNER_ADDRESSES) {
    assert.deepEqual(bodies.find(sent => sent.to === to), { to, subject: full.subject, body: full.body }, 'each owner address gets the full composed message');
  }
  const gateway = bodies[2];
  assert.equal(gateway.to, OWNER_VTEXT_ADDRESS);
  assert.equal(gateway.subject, 'Front desk message');
  assert.equal(gateway.body, texts[0].body, 'the gateway carries the same short text as the SignalWire message');
  assert.match(gateway.body, /^Front desk message from \+18125550123 \(Jane Caller\)\./);
  assert(!/Transcript|Only you receive these messages/.test(gateway.body), 'the gateway mail is not the full composed message');
});

test('a refused SignalWire text is delivered by the gateway mail, and the response names that route', async () => {
  const quiet = console.error; console.error = () => {};
  try {
    const bodies = [], sent = [], db = fakeDb();
    const h = createFrontdeskHandler({
      getDb: () => db,
      mail: mailer(bodies),
      text: createOwnerTexter({ env, fetcher: async () => { sent.push(1); return new Response('nope', { status: 401 }); } }),
      env, now: () => new Date('2026-10-13T18:05:00.000Z'),
    });
    const body = await (await h.message(request(callPayload()))).json();
    assert.equal(sent.length, 1, 'the SignalWire text is still attempted');
    assert.equal(body.texted, true, 'the text channel counts as delivered');
    assert.equal(body.textVia, 'vtext', 'the route that delivered the text is named');
    assert.equal(body.ok, true); assert.deepEqual(body.emailed, [...OWNER_ADDRESSES]);
    assert.match(body.textError, /SignalWire messaging returned 401/, 'the SignalWire failure is still reported');
    assert.equal(bodies.length, 3);
    assert.equal(bodies[2].to, OWNER_VTEXT_ADDRESS);
    assert.match(bodies[2].body, /^Front desk message from \+18125550123 \(Jane Caller\)\. Jane called about/);
    // The text channel is recorded as delivered, so a later report sends nothing.
    const repeat = await (await h.message(request(callPayload()))).json();
    assert.equal(repeat.duplicate, true);
    assert.equal(bodies.length, 3); assert.equal(sent.length, 1);
  } finally { console.error = quiet; }
});

test('when both text routes fail the response reports the failure and the error text', async () => {
  const quiet = console.error; console.error = () => {};
  try {
    const bodies = [];
    const h = createFrontdeskHandler({
      getDb: () => fakeDb(),
      mail: async value => { if (value.to === OWNER_VTEXT_ADDRESS) throw new Error('gateway refused'); bodies.push(value); return true; },
      text: async () => { throw new Error('messaging down'); },
      env, now: () => new Date('2026-10-13T18:05:00.000Z'),
    });
    const body = await (await h.message(request(callPayload()))).json();
    assert.equal(body.texted, false);
    assert.equal(body.textVia, 'none');
    assert.equal(body.textError, 'messaging down');
    assert.equal(body.ok, true, 'a failed gateway send does not become a failed email');
    assert.deepEqual(body.emailed, [...OWNER_ADDRESSES]);
    assert.equal(bodies.length, 2, 'the two owner emails still went out');
    assert.match(body.message, /the text message did not go out/);
    // Neither route can suppress the other: both are attempted whatever the other does.
    const calls = [];
    const both = createFrontdeskHandler({
      getDb: () => fakeDb(),
      mail: async value => { calls.push(`mail ${value.to}`); if (value.to === OWNER_VTEXT_ADDRESS) throw new Error('gateway refused'); return true; },
      text: async () => { calls.push('signalwire'); throw new Error('messaging down'); },
      env, now: () => new Date('2026-10-13T18:05:00.000Z'),
    });
    const bothBody = await (await both.message(request(callPayload()))).json();
    assert(calls.includes('signalwire'), 'the SignalWire attempt still runs when the gateway fails');
    assert(calls.includes(`mail ${OWNER_VTEXT_ADDRESS}`), 'the gateway send still runs when SignalWire fails');
    assert.equal(bothBody.texted, false); assert.equal(bothBody.textVia, 'none');
  } finally { console.error = quiet; }
});

test('the call-id duplicate rule still holds: a repeat delivery sends nothing to any recipient', async () => {
  const { db, bodies, texts, h } = handler();
  await h.message(request(callPayload()));
  assert.equal(bodies.length, 3); assert.equal(texts.length, 1);
  const repeat = await (await h.message(request(callPayload()))).json();
  assert.equal(repeat.duplicate, true);
  assert.equal(repeat.texted, false); assert.deepEqual(repeat.emailed, []);
  assert.equal(bodies.length, 3, 'no mail goes to either owner address or to the gateway');
  assert.equal(texts.length, 1, 'no SignalWire text is sent again');
  assert.equal(bodies.filter(sent => sent.to === OWNER_VTEXT_ADDRESS).length, 1, 'the gateway is mailed once, for the first delivery');
  assert.equal(db.events.length, 1, 'the repeated report is not stored twice');
});

test('a gateway text does not stand in for the mandatory email, and is not sent twice', async () => {
  const db = fakeDb(), bodies = [], texts = [];
  const quiet = console.error; console.error = () => {};
  try {
    let emailBroken = true;
    const mail = async value => { if (emailBroken && value.to !== OWNER_VTEXT_ADDRESS) throw new Error('webhook down'); bodies.push(value); return true; };
    const build = () => createFrontdeskHandler({ getDb: () => db, mail, text: async value => { texts.push(value); return true; }, env, now: () => new Date('2026-10-13T18:05:00.000Z') });
    const failed = await (await build().message(request(callPayload()))).json();
    assert.deepEqual(failed.emailed, []); assert.equal(failed.emailFailed.length, OWNER_ADDRESSES.length);
    assert.equal(failed.texted, true); assert.equal(failed.textVia, 'signalwire'); assert.equal(failed.ok, false);
    assert.equal(db.events[0].emailed, false, 'a text is not an email, so the stored row does not claim Douglas was emailed');
    assert.equal(db.calls.get('call-abc').emailed, false, 'and neither does the claim row');
    assert.equal(bodies.length, 1, 'only the gateway mail went out');
    // The next report for this call sends the email the owner is owed, and nothing on the text channel.
    emailBroken = false;
    const retried = await (await build().message(request(callPayload()))).json();
    assert.equal(retried.duplicate, false);
    assert.deepEqual(retried.emailed, [...OWNER_ADDRESSES]);
    assert.equal(retried.textVia, 'none', 'nothing is sent on the text channel again');
    assert.equal(texts.length, 1, 'the SignalWire text went out once');
    assert.equal(bodies.filter(sent => sent.to === OWNER_VTEXT_ADDRESS).length, 1, 'the gateway mail went out once');
    assert.equal(db.events[0].emailed, true);
    assert.equal((await (await build().message(request(callPayload()))).json()).duplicate, true);
  } finally { console.error = quiet; }
});

test('the request-length and transcript caps are unaffected by the gateway copy', async () => {
  const { bodies, texts, h } = handler();
  const record = readFrontdeskMessage(callPayload({ call_log: [...Array(400).keys()].map(i => ({ role: 'user', content: `note ${i}` })) }));
  assert.equal(record.transcript.length, 200); assert.equal(record.transcriptTruncated, true);
  // A summary far past the text cap is cut for the gateway copy as well as for the full message.
  const heavy = await (await h.message(request({ ...callPayload(), call_log: [...Array(250).keys()].map(i => ({ role: 'user', content: `${i} ${'y'.repeat(120)}` })), post_prompt_data: { raw: 'z'.repeat(9000) } }))).json();
  assert.equal(heavy.ok, true);
  assert.equal(bodies.length, 3); assert.equal(texts.length, 1);
  assert(bodies[0].body.length < 30000, 'the full composed message stays bounded');
  assert(bodies[2].body.length <= 300, `the gateway copy stays within about two SMS segments (was ${bodies[2].body.length})`);
  assert(bodies[2].body.length < bodies[0].body.length, 'the gateway gets the short text, not the full message');
  assert(!/[\r\n]/.test(bodies[2].body));
  // The byte cap on the request is unchanged, and a refused report sends nothing anywhere.
  assert.equal((await h.message(request({ ...callPayload(), call_id: 'call-oversize', pad: 'x'.repeat(300000) }))).status, 413);
  assert.equal(bodies.length, 3); assert.equal(texts.length, 1);
});
