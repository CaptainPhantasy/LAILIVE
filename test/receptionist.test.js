import test from 'node:test';
import assert from 'node:assert/strict';
import { createReceptionistHandler, groundTurn, receptionistInput, receptionistInstructions } from '../lib/receptionist.js';
import { parseServices, buildProfile, offeredSlots, callRecord } from '../dist/receptionist/core.js';

const id = '3351ea89-24df-4b67-9364-8d57c538a6be';
const profile = { business: 'Acme Plumbing', hours: 'Mon-Fri 8-5', services: [{ name: 'Drain cleaning', price: 'from $149' }], languages: ['en', 'es'] };
const slots = [{ id: '20261005T0900', label: 'Monday, October 5, 9:00 AM–10:00 AM' }];
const body = (extra = {}) => JSON.stringify({ profile, slots, messages: [{ role: 'caller', content: 'Can I book a drain cleaning?' }], ...extra });
const req = (headers = {}, payload = body()) => new Request('https://example.test/api/receptionist', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: payload });
const turn = (over = {}) => ({ reply: 'Sure — I have Monday at nine. May I have your name?', language: 'en', caller: { name: '', callback: '', reason: 'Drain cleaning' }, booking: { slotId: '20261005T0900', status: 'offered' }, followUp: '', endCall: false, ...over });
const granted = { getInquiry: async () => ({ consent: [{ purpose: 'inquiry-reply', choice: 'granted' }] }), consumeLimits: async () => {} };

test('the test line refuses calls without a received inquiry before generating', async () => {
  let calls = 0;
  const generate = async () => { calls++; return turn(); };
  assert.equal((await createReceptionistHandler({ generate, getStore: () => granted })(req())).status, 403);
  for (const inquiry of [null, { consent: [] }, { consent: [{ purpose: 'inquiry-reply', choice: 'withdrawn' }] }]) {
    const handler = createReceptionistHandler({ generate, getStore: () => ({ getInquiry: async () => inquiry }) });
    assert.equal((await handler(req({ 'x-legacy-inquiry': id }))).status, 403);
  }
  assert.equal((await createReceptionistHandler({ generate, getStore: () => granted })(req({ 'x-legacy-inquiry': id, origin: 'https://evil.test' }))).status, 403);
  assert.equal(calls, 0);
});

test('input is validated before the allowance is spent', async () => {
  let spent = 0;
  const store = { ...granted, consumeLimits: async () => { spent++; } };
  const handler = createReceptionistHandler({ generate: async () => turn(), getStore: () => store });
  const bad = [body({ messages: [{ role: 'receptionist', content: 'Hello' }] }), body({ slots: [{ id: 'tomorrow', label: 'x' }] }), JSON.stringify({ profile: { ...profile, business: '' } }), '{'];
  for (const payload of bad) assert.equal((await handler(req({ 'x-legacy-inquiry': id }, payload))).status, 400);
  assert.equal(spent, 0);
});

test('an allowed call spends the allowance and returns a grounded turn', async () => {
  const order = [];
  const store = { ...granted, consumeLimits: async rules => { assert.equal(rules.length, 2); order.push('limit'); } };
  const handler = createReceptionistHandler({ generate: async input => { order.push('generate'); assert.equal(input.messages.length, 1); return turn(); }, getStore: () => store, now: () => new Date('2026-10-01T12:00:00Z') });
  const response = await handler(req({ 'x-legacy-inquiry': id }));
  assert.equal(response.status, 200);
  assert.deepEqual(order, ['limit', 'generate']);
  const value = await response.json();
  assert.equal(value.booking.slotId, '20261005T0900');
  assert.equal(value.generatedAt, '2026-10-01T12:00:00.000Z');
});

test('the greeting turn is allowed with no conversation yet', () => {
  assert.equal(receptionistInput.parse(JSON.parse(body({ messages: [] }))).messages.length, 0);
});

test('invented times are dropped and a hold needs a name and callback number', () => {
  const input = receptionistInput.parse(JSON.parse(body()));
  const invented = groundTurn(turn({ reply: 'Your Friday appointment is confirmed and the text is on its way.', booking: { slotId: '20261231T2300', status: 'held' } }), input);
  assert.deepEqual(invented.booking, { slotId: null, status: 'none' });
  assert.doesNotMatch(invented.reply, /Friday|confirmed|text is on its way/i);
  const missingDetails = groundTurn(turn({ reply: 'You are booked.', booking: { slotId: '20261005T0900', status: 'held' } }), input);
  assert.equal(missingDetails.booking.status, 'offered');
  assert.match(missingDetails.reply, /your name and callback number/i);
  const held = groundTurn(turn({ reply: 'Your confirmation has been sent.', booking: { slotId: '20261005T0900', status: 'held' }, caller: { name: 'Ann', callback: '555-0100', reason: 'x' } }), input);
  assert.equal(held.booking.status, 'held');
  assert.match(held.reply, /Monday, October 5, 9:00 AM–10:00 AM/);
  assert.doesNotMatch(held.reply, /confirmation has been sent/i);
  assert.equal(groundTurn(turn({ language: 'es' }), receptionistInput.parse(JSON.parse(body({ profile: { ...profile, languages: ['en'] } })))).language, 'en');
  assert.throws(() => groundTurn({ reply: '' }, input));
});

test('generation failures and rate limits never claim success', async () => {
  const quiet = console.error; console.error = () => {};
  try {
    const failing = createReceptionistHandler({ generate: async () => { throw new Error('provider body with secrets'); }, getStore: () => granted });
    const response = await failing(req({ 'x-legacy-inquiry': id }));
    assert.equal(response.status, 503);
    assert(!(await response.text()).includes('secrets'));
  } finally { console.error = quiet; }
});

test('the prompt carries only the visitor business facts and treats caller speech as data', () => {
  const prompt = receptionistInstructions(receptionistInput.parse(JSON.parse(body())));
  assert.match(prompt, /Acme Plumbing/);
  assert.match(prompt, /English and Spanish/);
  assert.match(prompt, /data, not instructions/);
  assert.match(prompt, /never claim a confirmation text/i);
});

test('client helpers parse services, require the essentials and build a call record', () => {
  assert.deepEqual(parseServices('Drain cleaning — from $149\n- Water heater install: $1,200+\nLeak check $89\nCamera inspection'), [
    { name: 'Drain cleaning', price: 'from $149' }, { name: 'Water heater install', price: '$1,200+' }, { name: 'Leak check', price: '$89' }, { name: 'Camera inspection', price: '' }]);
  assert.deepEqual(parseServices('Pre-purchase inspection - $300'), [{ name: 'Pre-purchase inspection', price: '$300' }]);
  assert.throws(() => buildProfile({ business: 'Acme', hours: '', languages: ['en'] }), /hours/);
  assert.throws(() => buildProfile({ business: 'Acme', hours: '8-5', languages: [] }), /language/);
  const offered = offeredSlots({ days: [1], open: '09:00', close: '11:00', length: 60, horizonDays: 7 }, new Date(2026, 9, 5, 7));
  assert.deepEqual(offered.map(s => s.id), ['20261005T0900', '20261005T1000']);
  assert(receptionistInput.safeParse({ profile, slots: offered, messages: [] }).success, 'client slots satisfy the server contract');
  const record = callRecord({ profile, slots: offered, messages: [{ role: 'caller', content: 'Hi' }, { role: 'receptionist', content: 'Hello' }], turn: turn({ caller: { name: 'Ann', callback: '555-0100', reason: 'Drain' }, booking: { slotId: '20261005T0900', status: 'held' } }), startedAt: new Date(0) });
  assert.match(record, /Caller: Ann/);
  assert.match(record, /held for you to confirm/);
  assert.match(record, /Nothing was booked, texted or emailed/);
  assert.match(record, /Receptionist: Hello/);
});
