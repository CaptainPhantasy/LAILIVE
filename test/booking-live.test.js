import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createLiveBooking, createLiveBookingHandler } from '../lib/booking-live.js';
import { createBookingCalendarProvider, LEGACY_BOOKING_CALENDAR_ID } from '../lib/booking-live-provider.js';
import { bookingSwaigFunctions } from '../lib/booking-live-swaig.js';

const time = Date.parse('2026-10-17T19:00:00Z');
const details = { slotStart: '2026-10-19T16:00:00Z', name: 'Test Caller', email: 'TEST@example.com', phone: '+18125550123', requestId: 'call-123:slot1', approved: true };
function fakeProvider() {
  const events = new Map();
  const provider = { configured: true, calendarId: LEGACY_BOOKING_CALENDAR_ID, calls: [], busy: async () => [...events.values()].filter(event => event.status === 'confirmed').map(event => ({ start: event.start.dateTime, end: event.end.dateTime })),
    insert: async event => { provider.calls.push(event); const saved = { ...event, kind: 'calendar#event', status: 'confirmed' }; events.set(event.id, saved); return saved; },
    get: async id => { if (!events.has(id)) throw new Error('Not found'); return events.get(id); }, events };
  return provider;
}
async function withBooking(fn) {
  const pg = new PGlite(), db = drizzle(pg), provider = fakeProvider();
  const booking = createLiveBooking({ getDb: () => db, provider, now: () => time });
  try { await fn({ pg, db, provider, booking }); } finally { await pg.close(); }
}

test('availability exposes only valid weekday slots, respects busy events and thirty-minute buffers', async () => withBooking(async ({ booking, provider }) => {
  provider.busy = async () => [{ start: '2026-10-19T17:00:00Z', end: '2026-10-19T18:00:00Z', privateTitle: 'Do not disclose' }];
  const result = await booking.availability({ fromDate: '2026-10-19', days: 1 });
  assert.equal(result.available, true);
  assert.deepEqual(result.slots.map(slot => slot.start), ['2026-10-19T18:30:00.000Z', '2026-10-19T19:00:00.000Z']);
  assert.ok(!JSON.stringify(result).includes('Do not disclose'));
  assert.equal((await booking.availability({ fromDate: '2026-10-18', days: 1 })).slots.length, 0);
}));

test('Indiana daylight saving change is applied to offered local slots', async () => withBooking(async ({ booking }) => {
  const result = await booking.availability({ fromDate: '2026-11-02', days: 1 });
  assert.equal(result.slots[0].start, '2026-11-02T17:00:00.000Z');
  assert.equal(result.slots.at(-1).end, '2026-11-02T21:00:00.000Z');
}));

test('booking persists a real event receipt, requests attendee invitation, and replays without another insert', async () => withBooking(async ({ booking, provider, pg }) => {
  const first = await booking.reserve(details);
  assert.equal(first.booked, true); assert.equal(first.invitationRequested, true); assert.equal(first.invitationDelivered, null);
  assert.equal(provider.calls.length, 1);
  assert.deepEqual(provider.calls[0].attendees, [{ email: 'test@example.com', displayName: 'Test Caller', responseStatus: 'needsAction' }]);
  assert.match(provider.calls[0].id, /^[a-f0-9]{64}$/);
  assert.equal((await booking.reserve(details)).replay, true);
  assert.equal(provider.calls.length, 1);
  assert.equal((await pg.query('SELECT status FROM legacy_live_bookings')).rows[0].status, 'confirmed');
  const overlap = await booking.reserve({ ...details, requestId: 'othercall', slotStart: '2026-10-19T17:00:00Z' });
  assert.equal(overlap.booked, false);
  assert.equal(provider.calls.length, 1);
  assert.equal((await booking.reserve({ ...details, requestId: 'latercall', slotStart: '2026-10-19T17:30:00Z' })).booked, true);
}));

test('a new manual calendar conflict is checked immediately before event insertion', async () => withBooking(async ({ booking, provider, pg }) => {
  provider.busy = async () => [{ start: details.slotStart, end: '2026-10-19T17:00:00Z' }];
  assert.equal((await booking.reserve(details)).booked, false);
  assert.equal(provider.calls.length, 0);
  assert.equal((await pg.query('SELECT status FROM legacy_live_bookings')).rows[0].status, 'conflict');
}));

test('manual Calendar moves and cancellations free the original confirmed slot', async () => withBooking(async ({ booking, provider }) => {
  const reservation = await booking.reserve(details);
  const event = provider.events.get(reservation.eventId);
  provider.events.set(event.id, { ...event, start: { dateTime: '2026-10-19T18:00:00Z' }, end: { dateTime: '2026-10-19T19:00:00Z' } });
  let slots = (await booking.availability({ fromDate: '2026-10-19', days: 1 })).slots.map(slot => slot.start);
  assert.ok(slots.includes('2026-10-19T16:00:00.000Z'));
  assert.ok(!slots.includes('2026-10-19T18:00:00.000Z'));
  provider.events.set(event.id, { ...event, status: 'cancelled' });
  slots = (await booking.availability({ fromDate: '2026-10-19', days: 1 })).slots.map(slot => slot.start);
  assert.ok(slots.includes('2026-10-19T18:00:00.000Z'));
  assert.equal((await booking.reserve({ ...details, requestId: 'after-cancellation' })).booked, true);
}));

test('unknown write outcome keeps its durable slot hold and reconciles instead of sending twice', async () => withBooking(async ({ booking, provider, pg }) => {
  const original = provider.insert;
  provider.insert = async event => { await original(event); throw new Error('Response lost'); };
  const first = await booking.reserve(details);
  assert.equal(first.booked, false); assert.equal(first.uncertain, true);
  assert.equal((await pg.query('SELECT status FROM legacy_live_bookings')).rows[0].status, 'uncertain');
  assert.equal((await booking.reserve({ ...details, requestId: 'other' })).booked, false);
  assert.equal((await booking.reserve(details)).booked, true);
  assert.equal(provider.calls.length, 1);
}));

test('a pending external write excludes a competing caller before provider completion', async () => withBooking(async ({ booking, provider }) => {
  let release, started;
  const signal = new Promise(resolve => { started = resolve; });
  const original = provider.insert;
  provider.insert = async event => { started(); await new Promise(resolve => { release = resolve; }); return original(event); };
  const first = booking.reserve(details);
  await signal;
  assert.equal((await booking.reserve({ ...details, requestId: 'competing-call' })).booked, false);
  release(); assert.equal((await first).booked, true);
  assert.equal(provider.calls.length, 1);
}));

test('invalid approval, hours, identity, email, and mismatched retries never write', async () => withBooking(async ({ booking, provider }) => {
  for (const change of [{ approved: false }, { email: 'bad' }, { requestId: '' }, { slotStart: '2026-10-19T19:30:00Z' }, { slotStart: '2026-10-18T16:00:00Z' }, { slotStart: '2026-10-19T16:00:00' }]) {
    assert.equal((await booking.reserve({ ...details, ...change })).booked, false);
  }
  assert.equal(provider.calls.length, 0);
  assert.equal((await booking.reserve(details)).booked, true);
  assert.equal((await booking.reserve({ ...details, email: 'different@example.com' })).booked, false);
  assert.equal(provider.calls.length, 1);
}));

test('an unverified event response cannot confirm or release the slot', async () => withBooking(async ({ booking, provider, pg }) => {
  provider.insert = async event => ({ ...event, kind: 'calendar#event', status: 'cancelled' });
  assert.equal((await booking.reserve(details)).booked, false);
  assert.equal((await pg.query('SELECT status FROM legacy_live_bookings')).rows[0].status, 'uncertain');
}));

test('SWAIG endpoint authenticates before database use and never exposes arbitrary actions', async () => {
  let calls = 0;
  const booking = { configured: true, rate: async () => true, availability: async () => { calls++; return { slots: [] }; }, reserve: async args => { calls++; return { booked: true, requestId: args.requestId }; } };
  const handler = createLiveBookingHandler({ env: { RECEPTIONIST_WEBHOOK_SECRET: 'test-secret' }, booking });
  const req = (body, auth = true) => new Request('https://legacyai.space/api/frontdesk/booking', { method: 'POST', headers: { ...(auth ? { 'x-frontdesk-secret': 'test-secret' } : {}) }, body: JSON.stringify(body) });
  const body = { function: 'check_availability', call_id: 'call-123', argument: { parsed: [{}] } };
  assert.equal((await handler(req(body, false))).status, 401); assert.equal(calls, 0);
  assert.equal((await handler(req({ ...body, function: 'delete_event' }))).status, 400); assert.equal(calls, 0);
  assert.equal((await handler(req(body))).status, 200); assert.equal(calls, 1);
  const response = await handler(req({ ...body, function: 'book_appointment', argument: { parsed: [{ ...details, requestId: 'attacker-chosen' }] } }));
  const result = JSON.parse((await response.json()).response);
  assert.match(result.requestId, /^call-123:/);
});

test('calendar provider uses exact API calls and accepts observed Zapier resource envelope only', async () => {
  const calls = [];
  const properties = Object.fromEntries(['url', 'fail_on_errors', 'headers', 'querystring', 'body', 'method'].map(name => [name, {}]));
  const env = { BOOKING_ZAPIER_MCP_URL: 'https://mcp.zapier.com/api/mcp/test', BOOKING_ZAPIER_GET_TOOL: 'google_get', BOOKING_ZAPIER_WRITE_TOOL: 'google_write', BOOKING_CALENDAR_ID: LEGACY_BOOKING_CALENDAR_ID };
  let responseResource;
  const fetcher = async (_url, init) => {
    const rpc = JSON.parse(init.body); calls.push(rpc);
    if (rpc.method === 'notifications/initialized') {
      assert.equal('id' in rpc, false);
      return new Response(null, { status: 202 });
    }
    const result = rpc.method === 'initialize' ? { protocolVersion: '2024-11-05' }
      : rpc.method === 'tools/list' ? { tools: ['google_get', 'google_write'].map(name => ({ name, inputSchema: { type: 'object', properties, required: ['url', 'fail_on_errors'] } })) }
      : { content: [{ type: 'text', text: JSON.stringify({ results: [{ status: 200, body: responseResource }] }) }] };
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
  };
  const provider = createBookingCalendarProvider({ env, fetcher });
  responseResource = { kind: 'calendar#freeBusy', calendars: { [LEGACY_BOOKING_CALENDAR_ID]: { busy: [] } } };
  assert.deepEqual(await provider.busy('2026-10-19T16:00:00Z', '2026-10-19T20:00:00Z'), []);
  assert.deepEqual(calls.slice(0, 3).map(call => call.method), ['initialize', 'notifications/initialized', 'tools/list']);
  let action = calls.at(-1).params.arguments;
  assert.equal(action.url, 'https://www.googleapis.com/calendar/v3/freeBusy'); assert.equal(action.method, 'POST');
  assert.deepEqual(JSON.parse(action.body).items, [{ id: LEGACY_BOOKING_CALENDAR_ID }]);
  responseResource = { kind: 'calendar#event', id: 'abc123', status: 'confirmed' };
  await provider.insert({ id: 'abc123' }); action = calls.at(-1).params.arguments;
  assert.equal(action.url, `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(LEGACY_BOOKING_CALENDAR_ID)}/events?sendUpdates=all`);
  await provider.get('abc123'); assert.equal(calls.at(-1).params.name, 'google_get');
  assert.equal(calls.at(-1).params.arguments.url, `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(LEGACY_BOOKING_CALENDAR_ID)}/events/abc123`);
  responseResource = { message: 'Success! Appointment booked!' };
  await assert.rejects(provider.get('abc123'), /verifiable resource/);
  const previousCalls = calls.length;
  await assert.rejects(provider.get('abc123', { deadline: Date.now() - 1 }), /deadline exceeded/);
  assert.equal(calls.length, previousCalls);
});

test('missing runtime calendar connection reports unavailable and tool definitions safely encode credentials', async () => {
  const booking = createLiveBooking({ getDb: () => { throw new Error('Must not be touched'); }, env: {} });
  assert.equal((await booking.availability()).booked, false);
  assert.equal((await booking.reserve(details)).booked, false);
  const tools = bookingSwaigFunctions({ webhookSecret: 'test%secret?/#' });
  assert.equal(decodeURIComponent(new URL(tools[0].web_hook_url).password), 'test%secret?/#');
  assert.deepEqual(tools.map(tool => tool.function), ['check_availability', 'book_appointment']);
});

test('one generic Zapier API tool supplies its required HTTP method for both GET and POST', async () => {
  const actions = [];
  const env = { BOOKING_ZAPIER_MCP_URL: 'https://mcp.zapier.com/api/mcp/test', BOOKING_ZAPIER_GET_TOOL: 'google_api_request', BOOKING_ZAPIER_WRITE_TOOL: 'google_api_request', BOOKING_CALENDAR_ID: LEGACY_BOOKING_CALENDAR_ID };
  const fetcher = async (_url, init) => {
    const rpc = JSON.parse(init.body);
    if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let result;
    if (rpc.method === 'initialize') result = { protocolVersion: '2024-11-05' };
    else if (rpc.method === 'tools/list') result = { tools: [{ name: 'google_api_request', inputSchema: { type: 'object', properties: { url: {}, method: {}, body: {}, fail_on_errors: {} }, required: ['url', 'method', 'fail_on_errors'] } }] };
    else {
      actions.push(rpc.params);
      result = { content: [{ type: 'text', text: JSON.stringify({ results: [{ status: 200, body: { kind: 'calendar#event', id: 'abc123', status: 'confirmed' } }] }) }] };
    }
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
  };
  const provider = createBookingCalendarProvider({ env, fetcher });
  await provider.get('abc123');
  await provider.insert({ id: 'abc123' });
  assert.deepEqual(actions.map(action => action.name), ['google_api_request', 'google_api_request']);
  assert.deepEqual(actions.map(action => action.arguments.method), ['GET', 'POST']);
  assert.equal('body' in actions[0].arguments, false);
  assert.deepEqual(JSON.parse(actions[1].arguments.body), { id: 'abc123' });
});


test('calendar isolation rejects missing, primary and every other calendar before any network request', async () => {
  for (const calendarId of [undefined, '', 'primary', 'owner@example.com', `${'a'.repeat(64)}@group.calendar.google.com`, `${LEGACY_BOOKING_CALENDAR_ID} `]) {
    let fetches = 0;
    const env = { BOOKING_ZAPIER_MCP_URL: 'https://mcp.zapier.com/api/mcp/test', BOOKING_ZAPIER_GET_TOOL: 'google_get', BOOKING_ZAPIER_WRITE_TOOL: 'google_write', ...(calendarId === undefined ? {} : { BOOKING_CALENDAR_ID: calendarId }) };
    const provider = createBookingCalendarProvider({ env, fetcher: async () => { fetches++; throw new Error('No calendar request is permitted.'); } });
    assert.equal(provider.configured, false);
    assert.equal(provider.calendarId, LEGACY_BOOKING_CALENDAR_ID);
    await assert.rejects(provider.busy('2026-10-19T16:00:00Z', '2026-10-19T20:00:00Z'), /dedicated Legacy AI booking calendar is not configured/);
    await assert.rejects(provider.insert({ id: 'abc123' }), /dedicated Legacy AI booking calendar is not configured/);
    await assert.rejects(provider.get('abc123'), /dedicated Legacy AI booking calendar is not configured/);
    assert.equal(fetches, 0);
  }
});
