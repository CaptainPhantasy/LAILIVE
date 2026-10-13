import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createOwnerMailer } from '../lib/assistant.js';
import { createFrontdeskHandler, createOwnerTexter, composeFrontdeskMessage, composeFrontdeskText, readFrontdeskMessage, OWNER_ADDRESSES, OWNER_NUMBER } from '../lib/frontdesk.js';

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
    ok: true, stored: true, emailed: [...OWNER_ADDRESSES], texted: true, duplicate: false, callId: 'call-abc',
    message: 'Douglas was emailed and texted about this call.',
  });
  const row = db.events[0];
  assert.equal(row.kind, 'contact_request'); assert.equal(row.channel, 'phone');
  assert.equal(row.contact, '+18125550123'); assert.equal(row.visitor_name, 'Jane Caller');
  assert.equal(row.summary, 'Jane called about a new website for her plumbing business. Call her back after 3 pm.');
  assert.equal(row.conversation_id, 'call-abc'); assert.equal(row.question, '', 'the digest shows the summary, not a stray question');
  assert.equal(row.emailed, true);
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies.map(b => b.to), [...OWNER_ADDRESSES]);
  assert.match(bodies[0].subject, /Front desk message/);
  assert.match(bodies[0].subject, /\+18125550123/);
  assert.match(bodies[0].subject, /Jane Caller/);
  assert.match(bodies[0].body, /Jane called about a new website for her plumbing business/);
  assert.match(bodies[0].body, /Caller: I need a website for my plumbing business\./);
  assert.match(bodies[0].body, /Front desk: Legacy AI, how can I help\?/);
  assert.match(bodies[0].body, /Call id: call-abc/);
  assert.match(bodies[0].body, /Only you receive these messages/);
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
  assert.equal(bodies.length, 2); assert.equal(texts.length, 1);
  // A different call still gets through.
  assert.equal((await h.message(request(callPayload({ call_id: 'call-def' })))).status, 200);
  assert.equal(db.events.length, 2); assert.equal(bodies.length, 4);
});

test('a stored call whose notification failed is retried instead of being swallowed', async () => {
  const db = fakeDb(), bodies = [], texts = [];
  const first = createFrontdeskHandler({ getDb: () => db, mail: async () => { throw new Error('mail provider down'); }, text: async () => { throw new Error('messaging down'); }, env, now: () => new Date('2026-10-13T18:05:00.000Z') });
  const quiet = console.error; console.error = () => {};
  try {
    const failed = await (await first.message(request(callPayload()))).json();
    assert.deepEqual(failed, { ok: false, stored: true, emailed: [], emailFailed: [...OWNER_ADDRESSES], texted: false, textError: 'messaging down', duplicate: false, callId: 'call-abc', message: 'This call was not sent to Douglas. Check the front desk configuration.' });
    assert.equal(db.events[0].emailed, false);
  } finally { console.error = quiet; }
  const second = handler({ db, bodies, texts });
  const retried = await (await second.h.message(request(callPayload()))).json();
  assert.equal(retried.duplicate, false); assert.equal(retried.texted, true);
  assert.equal(bodies.length, 2); assert.equal(texts.length, 1);
  assert.equal(db.events.length, 1, 'the retry records the delivery on the row the first attempt stored');
  assert.equal(db.events[0].emailed, true);
  // With the delivery recorded, the next report for the same call is not sent again.
  assert.equal((await (await second.h.message(request(callPayload()))).json()).duplicate, true);
  assert.equal(bodies.length, 2); assert.equal(texts.length, 1);
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
    assert.equal(value.texted, false); assert.match(value.textError, /FRONTDESK_SMS_FROM/);
    assert.equal(value.ok, true); assert.equal(bodies.length, 2); assert.equal(sent.length, 0, 'nothing is sent without the sender number');
    // A refused send is reported rather than thrown.
    const refused = createFrontdeskHandler({ getDb: () => fakeDb(), mail: async () => true, text: createOwnerTexter({ env, fetcher: async () => new Response('nope', { status: 401 }) }), env });
    const refusedBody = await (await refused.message(request(callPayload()))).json();
    assert.equal(refusedBody.texted, false); assert.match(refusedBody.textError, /SignalWire messaging returned 401/);
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
      assert.equal(response.status, 200); assert.equal(body.stored, false); assert.equal(body.texted, true);
      assert(body.storageError, 'the storage failure is named in the response');
    }
    assert.equal(bodies.length, 4); assert.equal(texts.length, 2);
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
  assert.equal(bodies.length, 2); assert.equal(texts.length, 1);
});
