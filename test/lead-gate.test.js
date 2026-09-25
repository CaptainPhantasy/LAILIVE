import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadLeadCatalog, prepareLeadInquiry, sendLeadInquiry } from '../dist/lead-gate.js';

const catalog = { services: [{ id: 'customer-list-that-actually-works', name: 'Customer List That Actually Works', tag: 'CRM', body: 'Organize the customer records you already have.' }], consent: { version: 'test-notice', inquiryText: 'Save this inquiry and reply about the requested work.', marketingText: 'Optional marketing emails.' }, capabilities: { inquiries: true } };
const fields = { name: 'Test Owner', email: 'owner@example.test', company: 'Test workshop', request: 'Help organize the customer records used by the workshop.', confirmed: true, marketingOptIn: false };
const context = { purpose: 'Customer-list project inquiry', serviceIds: ['customer-list-that-actually-works'] };

test('lead gate requires connected inquiry capability and an actual current notice', async () => {
  let calls = 0;
  const fetcher = async url => { calls++; assert.equal(url, '/api/concierge/catalog'); return Response.json(catalog); };
  assert.equal((await loadLeadCatalog({ fetcher })).consent.version, 'test-notice');
  assert.equal(calls, 1);
  for (const unavailable of [{ ...catalog, capabilities: { inquiries: false } }, { ...catalog, consent: null }]) {
    await assert.rejects(loadLeadCatalog({ fetcher: async () => Response.json(unavailable) }), /not connected/);
  }
  await assert.rejects(loadLeadCatalog({ fetcher: async () => Response.json({ error: 'Service unavailable' }, { status: 503 }) }), /Service unavailable/);
});

test('reviewed lead payload excludes CSV data and keeps marketing permission separate', () => {
  const payload = prepareLeadInquiry({ ...fields, csv: 'PRIVATE CUSTOMER ROWS', report: { records: ['private'] } }, { ...context, csv: 'DO NOT SEND' }, catalog);
  assert.deepEqual(Object.keys(payload).sort(), ['approval', 'company', 'email', 'message', 'name', 'serviceIds']);
  assert.equal(payload.message, `${context.purpose}\n\n${fields.request}`);
  assert.equal(payload.approval.marketingOptIn, false);
  assert.equal(payload.approval.confirmed, true);
  assert.doesNotMatch(JSON.stringify(payload), /PRIVATE|DO NOT SEND|private/);
  assert.throws(() => prepareLeadInquiry({ ...fields, confirmed: false }, context, catalog), /Confirm/);
  assert.throws(() => prepareLeadInquiry({ ...fields, request: ' ' }, context, catalog), /work you would like/);
});

test('only a successful durable receipt releases results; retries keep the supplied submission key', async () => {
  const payload = prepareLeadInquiry(fields, context, catalog), key = randomUUID(), id = randomUUID();
  const saved = { id, status: 'received', createdAt: '2026-09-25T12:00:00.000Z', replayed: false };
  const calls = [];
  const fetcher = async (url, options) => { calls.push({ url, options }); return Response.json({ ...saved, replayed: calls.length > 1 }, { status: calls.length > 1 ? 200 : 201 }); };
  const first = await sendLeadInquiry(payload, { key, fetcher });
  const retry = await sendLeadInquiry(payload, { key, fetcher });
  assert.equal(first.id, id); assert.equal(retry.id, id); assert.equal(retry.replayed, true);
  assert.ok(calls.every(call => call.url === '/api/inquiries' && call.options.method === 'POST' && call.options.headers['Idempotency-Key'] === key));
  assert.deepEqual(JSON.parse(calls[0].options.body), payload);
  await assert.rejects(sendLeadInquiry(payload, { key, fetcher: async () => Response.json({ status: 'received' }) }), /receipt was not confirmed/);
  await assert.rejects(sendLeadInquiry(payload, { key, fetcher: async () => Response.json(saved, { status: 503 }) }), /could not confirm/);
  await assert.rejects(sendLeadInquiry(payload, { key, fetcher: async () => { throw new Error('Network disconnected'); } }), /Network disconnected/);
});
