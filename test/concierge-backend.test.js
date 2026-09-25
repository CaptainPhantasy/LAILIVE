import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { generateKeyPair, SignJWT } from 'jose';
import { createStore } from '../lib/concierge/store.js';
import { createHandlers } from '../lib/concierge/handlers.js';
import { createOwnerAuth } from '../lib/concierge/auth.js';
import { catalog, consent, inquiryInput } from '../lib/concierge/contracts.js';
import { directIdentifiers, groundedIdentifiers, noticeVersion } from '../lib/concierge/identifiers.js';

// Only ephemeral SQL fixtures and locally signed tokens are used. No database URL,
// remote identity provider, model provider, or runtime customer records are touched.
const ownerEmail = 'douglastalley1977@gmail.com';
const issuer = 'https://owner-auth.example.test/auth';
const keys = await generateKeyPair('RS256');
const requireOwner = createOwnerAuth({ baseURL: issuer, email: ownerEmail, keys: keys.publicKey });
const migrations = await Promise.all(['0000_legacy_crm.sql', '0001_visitor_contacts.sql'].map(file => readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8')));

async function database(t) {
  const client = new PGlite();
  t.after(() => client.close());
  for (const migration of migrations) await client.exec(migration);
  return { client, store: createStore(drizzle(client)) };
}
function inquiry(overrides = {}) {
  return inquiryInput.parse({ name: 'Test contact', email: 'inquiry@example.test', company: 'Test workshop', message: 'Please discuss organizing our customer records.', serviceIds: [catalog.services[0].id, catalog.services[53].id], approval: { confirmed: true, consentVersion: consent.version, marketingOptIn: false }, ...overrides });
}
function request(path, { method = 'GET', token, body, headers = {} } = {}) {
  return new Request(`https://legacyai.space${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
async function token(claims = {}, overrides = {}) {
  return new SignJWT({ email: ownerEmail, emailVerified: true, ...claims }).setProtectedHeader({ alg: 'RS256' }).setIssuer(overrides.issuer ?? issuer).setAudience(overrides.audience ?? issuer).setSubject(overrides.subject ?? 'owner-test-subject').setIssuedAt().setExpirationTime(overrides.expires ?? '5m').sign(keys.privateKey);
}
const noGeneration = new Proxy({}, { get: (_, operation) => () => assert.fail(`Unexpected generation call: ${String(operation)}`) });

test('inquiry SQL transaction records separate permission choices and replays once without duplicating rows', async t => {
  const { client, store } = await database(t), input = inquiry(), key = randomUUID();
  const saved = await store.saveInquiry(input, key);
  assert.equal(saved.status, 'received');
  assert.equal(saved.replayed, false);
  assert.equal(saved.message, input.message);
  assert.deepEqual(new Set(saved.serviceIds), new Set(input.serviceIds));
  const repeated = await store.saveInquiry(inquiry(), key);
  assert.equal(repeated.id, saved.id);
  assert.equal(repeated.replayed, true);
  await assert.rejects(store.saveInquiry(inquiry({ message: 'A different request using the same key.' }), key), error => error.status === 409);
  const counts = (await client.query(`SELECT (SELECT count(*)::int FROM legacy_contacts) AS contacts, (SELECT count(*)::int FROM legacy_inquiries) AS inquiries, (SELECT count(*)::int FROM legacy_submission_receipts) AS receipts, (SELECT count(*)::int FROM legacy_inquiry_interests) AS interests, (SELECT count(*)::int FROM legacy_consent_events) AS events`)).rows[0];
  assert.deepEqual(counts, { contacts: 1, inquiries: 1, receipts: 1, interests: 2, events: 2 });
  const events = (await client.query('SELECT purpose, channel, choice, notice_version, notice_text, action FROM legacy_consent_events ORDER BY purpose')).rows;
  assert.deepEqual(events, [
    { purpose: 'inquiry-reply', channel: 'email', choice: 'granted', notice_version: consent.version, notice_text: consent.inquiryText, action: 'visitor-confirmed-inquiry-submit' },
    { purpose: 'marketing', channel: 'email', choice: 'declined', notice_version: consent.version, notice_text: consent.marketingText, action: 'visitor-confirmed-inquiry-submit' }
  ]);
});

test('SQL failure rolls back the receipt, contact and inquiry together, allowing a corrected retry', async t => {
  const { client, store } = await database(t), key = randomUUID(), input = inquiry();
  // This deliberately violates the actual interests table primary key after the
  // receipt/contact/inquiry inserts, exercising a real transaction rollback.
  await assert.rejects(store.saveInquiry({ ...input, serviceIds: [input.serviceIds[0], input.serviceIds[0]] }, key));
  for (const table of ['legacy_submission_receipts', 'legacy_contacts', 'legacy_inquiries', 'legacy_inquiry_interests', 'legacy_consent_events']) {
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 0, table);
  }
  const saved = await store.saveInquiry(input, key);
  assert.equal(saved.replayed, false);
  assert.equal((await store.getInquiry(saved.id)).email, input.email);
});

test('inquiry handler rejects absent approval or an old notice before touching the store', async () => {
  let accesses = 0;
  const handlers = createHandlers({ getStore() { accesses++; assert.fail('Unapproved input reached storage'); }, generation: noGeneration, requireOwner });
  for (const approval of [undefined, { confirmed: false, consentVersion: consent.version, marketingOptIn: false }, { confirmed: true, consentVersion: 'outdated-notice', marketingOptIn: true }]) {
    const response = await handlers.inquiries(request('/api/inquiries', { method: 'POST', headers: { 'idempotency-key': randomUUID() }, body: { ...inquiry(), approval } }));
    assert.equal(response.status, 400);
  }
  assert.equal(accesses, 0);
});

test('draft identifiers enrich one visitor while equal names and IP addresses never merge visitors or grant consent', async t => {
  const { client, store } = await database(t);
  const handlers = createHandlers({ getStore: () => store, generation: noGeneration, requireOwner });
  const firstId = randomUUID(), secondId = randomUUID();
  const base = { visitorId: firstId, page: '/intake/', fieldName: 'cg-name', value: 'Test Person', noticeVersion, signals: { collection: 'notice-shown', inquiryReply: false, marketing: false } };
  for (const body of [base, { ...base, fieldName: 'cg-message', value: 'You can identify this unfinished draft by person@example.test.' }, { ...base, visitorId: secondId }]) {
    const response = await handlers.visitor(request('/api/visitor', { method: 'POST', headers: { 'x-forwarded-for': '192.0.2.25' }, body }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { saved: true });
  }
  const contacts = await store.listContacts();
  assert.equal(contacts.length, 2);
  assert.deepEqual(contacts.find(c => c.visitorId === firstId).identifiers, [{ kind: 'name', value: 'Test Person' }, { kind: 'email', value: 'person@example.test' }]);
  assert.deepEqual(contacts.find(c => c.visitorId === secondId).identifiers, [{ kind: 'name', value: 'Test Person' }]);
  for (const contact of contacts) {
    assert.deepEqual(contact.ipAddresses, ['192.0.2.25']);
    assert.deepEqual(contact.signals, base.signals);
  }
  const evidence = await store.contactEvidence(firstId);
  assert.equal(evidence.length, 2);
  assert.ok(evidence.every(e => e.notice_version === noticeVersion && e.signals.marketing === false));
  assert.equal((await client.query('SELECT count(*)::int AS count FROM legacy_consent_events')).rows[0].count, 0);
  assert.equal((await client.query('SELECT count(*)::int AS count FROM legacy_inquiries')).rows[0].count, 0);
});

test('empty or nonidentifying draft text does not create a contact, and invented identifiers are discarded', async t => {
  const { client, store } = await database(t);
  const handlers = createHandlers({ getStore: () => store, generation: noGeneration, requireOwner });
  const base = { visitorId: randomUUID(), page: '/intake/', fieldName: 'unrecognized-field', value: 'A quiet afternoon', noticeVersion, signals: { collection: 'notice-shown', inquiryReply: false, marketing: false } };
  assert.deepEqual(directIdentifiers(base), []);
  assert.deepEqual(groundedIdentifiers([{ kind: 'name', value: 'Invented Person' }, { kind: 'unknown', value: 'quiet afternoon' }], base.value), []);
  const unknown = await handlers.visitor(request('/api/visitor', { method: 'POST', body: base }));
  assert.equal(unknown.status, 202);
  assert.equal((await unknown.json()).saved, false);
  const empty = await handlers.visitor(request('/api/visitor', { method: 'POST', body: { ...base, value: ' ' } }));
  assert.equal(empty.status, 400);
  for (const table of ['legacy_visitor_contacts', 'legacy_contact_evidence', 'legacy_consent_events']) {
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 0, table);
  }
});

test('signed owner JWT accepts only the named verified email and rejects missing, wrong or unverified identity', async () => {
  const verified = await token();
  assert.deepEqual(await requireOwner(request('/api/owner/inquiries', { token: verified })), { subject: 'owner-test-subject', email: ownerEmail });
  const alternativeClaim = await token({ email: ownerEmail.toUpperCase(), emailVerified: undefined, email_verified: true });
  assert.equal((await requireOwner(request('/api/owner/inquiries', { token: alternativeClaim }))).email.toLowerCase(), ownerEmail);
  const denied = [
    [undefined, 401], ['not.a.signed-token', 401],
    [await token({ email: undefined }), 403], [await token({ email: 'someoneelse@example.test' }), 403],
    [await token({ emailVerified: false }), 403], [await token({ emailVerified: 'true' }), 403],
    [await token({}, { issuer: 'https://wrong.example.test' }), 401],
    [await token({}, { audience: 'https://wrong.example.test' }), 401],
    [await token({}, { expires: '1 second ago' }), 401]
  ];
  for (const [value, status] of denied) await assert.rejects(requireOwner(request('/api/owner/inquiries', { token: value })), error => error.status === status);
});

test('owner handlers deny unauthorized requests before any store lookup or generation', async () => {
  let accesses = 0;
  const handlers = createHandlers({ getStore() { accesses++; assert.fail('Denied owner request reached storage'); }, generation: noGeneration, requireOwner });
  const routes = [
    ['ownerContacts', '/api/owner/contacts?format=csv', 'GET'],
    ['ownerContacts', `/api/owner/contacts?evidence=${randomUUID()}`, 'GET'],
    ['ownerInquiries', '/api/owner/inquiries', 'GET'],
    ['ownerInquiries', `/api/owner/inquiries?id=${randomUUID()}`, 'GET'],
    ['ownerInsights', '/api/owner/insights', 'GET'],
    ['ownerAssistant', '/api/owner/assistant', 'POST'],
    ['ownerFollowUp', '/api/owner/follow-up', 'POST']
  ];
  for (const [value, status] of [[undefined, 401], [await token({ email: 'not-owner@example.test' }), 403], [await token({ emailVerified: false }), 403]]) {
    for (const [handler, path, method] of routes) {
      const response = await handlers[handler](request(path, { method, token: value, ...(method === 'POST' ? { body: { question: 'Any contacts?', inquiryId: randomUUID() } } : {}) }));
      assert.equal(response.status, status, `${handler} must deny before data access`);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  }
  assert.equal(accesses, 0);
});

test('owner JWT must contain a nonempty identity subject', async () => {
  await assert.rejects(requireOwner(request('/api/owner/inquiries', { token: await token({}, { subject: '' }) })), error => error.status === 401 || error.status === 403);
});
