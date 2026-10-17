import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createLegacyConciergeAgent } from '../lib/receptionist-concierge.js';

const origin = 'https://preview.example.test';
const credentials = { origin, webhookSecret: 'w'.repeat(40), sessionSecret: 's'.repeat(40), getStore: () => assert.fail('Booking must not save a generic inquiry') };
const makeAgent = booking => createLegacyConciergeAgent({ ...credentials, booking });
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
  assert.deepEqual(observed[1], { ...args, requestId: `darla:${callId}` });
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
