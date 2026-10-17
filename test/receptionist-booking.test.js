import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createLegacyConciergeAgent } from '../lib/receptionist-concierge.js';
import { createLiveBooking } from '../lib/booking-live.js';

const origin = 'https://preview.example.test';
const credentials = { origin, webhookSecret: 'w'.repeat(40), sessionSecret: 's'.repeat(40), getStore: () => assert.fail('Booking must not save a generic inquiry') };
const makeAgent = booking => createLegacyConciergeAgent({ ...credentials, booking });
const attemptKey = args => createHash('sha256').update(JSON.stringify({ slotStart: args.slotStart, name: args.name, email: args.email, phone: args.phone, approved: args.approved })).digest('hex');
function call(agent, callId, name, args) {
  const ai = JSON.parse(agent.renderSwml(callId)).sections.main.find(step => step.ai).ai;
  const fn = ai.SWAIG.functions.find(item => item.function === name);
  const url = new URL(fn.web_hook_url || ai.SWAIG.defaults.web_hook_url);
  url.username = ''; url.password = '';
  return agent.getApp().fetch(new Request(url, { method: 'POST', headers: {
    'content-type': 'application/json', authorization: `Basic ${Buffer.from(`receptionist:${credentials.webhookSecret}`).toString('base64')}`,
  }, body: JSON.stringify({ function: name, call_id: callId, argument: { parsed: [args] } }) }));
}

test('Darla exposes actual provider slots and binds approved booking to the signed call identity', async () => {
  const observed = [], callId = randomUUID();
  const slot = { start: '2026-10-19T16:00:00.000Z', end: '2026-10-19T17:00:00.000Z' };
  const agent = await makeAgent({ configured: true,
    availability: async value => { observed.push(value); return { available: true, slots: [slot] }; },
    reserve: async value => { observed.push(value); return { booked: true, eventId: 'real-provider-receipt', invitationRequested: true, invitationDelivered: null }; },
  });
  const slots = JSON.parse((await (await call(agent, callId, 'check_availability', { date: '2026-10-19' })).json()).response);
  assert.deepEqual(slots.slots, [slot]); assert.deepEqual(observed[0], { fromDate: '2026-10-19' });
  const args = { slotStart: slot.start, name: 'Test caller', email: 'caller@example.test', approved: true };
  const result = JSON.parse((await (await call(agent, callId, 'book_appointment', args)).json()).response);
  assert.equal(result.booked, true); assert.equal(result.invitationDelivered, null);
  assert.deepEqual(observed[1], { ...args, requestId: `darla:${callId}:${attemptKey(args)}` });
});

test('identical booking details stay idempotent while a different slot gets a fresh attempt key', async () => {
  const observed = [], callId = randomUUID();
  const agent = await makeAgent({ configured: true, availability: async () => ({ available: true, slots: [] }), reserve: async value => { observed.push(value); return { booked: true }; } });
  const args = { slotStart: '2026-10-19T16:00:00Z', name: 'Test caller', email: 'caller@example.test', approved: true };
  await call(agent, callId, 'book_appointment', args);
  await call(agent, callId, 'book_appointment', { ...args });
  await call(agent, callId, 'book_appointment', { ...args, slotStart: '2026-10-19T17:00:00Z' });
  assert.equal(observed.length, 3);
  assert.equal(observed[0].requestId, `darla:${callId}:${attemptKey(args)}`);
  assert.equal(observed[1].requestId, observed[0].requestId);
  assert.notEqual(observed[2].requestId, observed[0].requestId);
  assert.match(observed[2].requestId, new RegExp(`^darla:${callId}:[0-9a-f]{64}$`));
});

test('a conflicted slot frees the caller to book a different slot within the same call', async () => {
  const events = new Map();
  const provider = { configured: true, calendarId: 'owner@example.com', calls: [], busy: async () => [...events.values()].filter(event => event.status === 'confirmed').map(event => ({ start: event.start.dateTime, end: event.end.dateTime })),
    insert: async event => { provider.calls.push(event); const saved = { ...event, kind: 'calendar#event', status: 'confirmed' }; events.set(event.id, saved); return saved; },
    get: async id => { if (!events.has(id)) throw new Error('Not found'); return events.get(id); } };
  const pg = new PGlite();
  try {
    const booking = createLiveBooking({ getDb: () => drizzle(pg), provider, now: () => Date.parse('2026-10-17T19:00:00Z') });
    const agent = await makeAgent(booking), callId = randomUUID();
    const args = slotStart => ({ slotStart, name: 'Test caller', email: 'caller@example.test', approved: true });
    provider.busy = async () => [{ start: '2026-10-19T16:00:00Z', end: '2026-10-19T17:00:00Z' }];
    const first = JSON.parse((await (await call(agent, callId, 'book_appointment', args('2026-10-19T16:00:00Z'))).json()).response);
    assert.equal(first.booked, false);
    provider.busy = async () => [];
    const second = JSON.parse((await (await call(agent, callId, 'book_appointment', args('2026-10-19T17:00:00Z'))).json()).response);
    assert.equal(second.booked, true);
    assert.equal(provider.calls.length, 1);
  } finally { await pg.close(); }
});

test('Darla does not confirm booking when the configured provider fails or calendar is disconnected', async () => {
  for (const booking of [{ configured: false }, { configured: true, reserve: async () => { throw new Error('private provider details'); } }]) {
    const agent = await makeAgent(booking);
    const response = JSON.parse((await (await call(agent, randomUUID(), 'book_appointment', { slotStart: '2026-10-19T16:00:00Z', name: 'Test', email: 'test@example.test', approved: true })).json()).response);
    assert.equal(response.booked, false); assert.ok(!JSON.stringify(response).includes('private provider'));
  }
});

test('rendered Darla instructions use current phone and conditional booking confirmation', async () => {
  const agent = await makeAgent({ configured: false });
  const swml = JSON.stringify(JSON.parse(agent.renderSwml(randomUUID())));
  assert.match(swml, /412-3454/); assert.ok(!swml.includes('302-2525'));
  assert.match(swml, /Only booked=true confirms/);
  assert.match(swml, /Inbox delivery|inbox delivery/);
  assert.ok(!swml.includes('Never book slots directly'));
});
