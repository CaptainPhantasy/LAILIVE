import test from 'node:test';
import assert from 'node:assert/strict';
import { recordIntent, rankIntent, readIntent, saveIntent } from '../dist/service-intent.js';
import { composeBrief, buildInquiry } from '../dist/concierge-core.js';

const services = [{ id: 'selected-tool', name: 'Selected tool' }, { id: 'opened-tool', name: 'Opened tool' }, { id: 'recommended-tool', name: 'Recommended tool' }];

test('actual selections outrank service clicks, which outrank AI recommendations; provenance stays separate', () => {
  let intent = [];
  for (const [id, kind] of [['recommended-tool', 'recommend'], ['opened-tool', 'read'], ['selected-tool', 'select'], ['not-in-catalog', 'read']]) intent = recordIntent(intent, id, kind);
  const ranked = rankIntent(intent, services);
  assert.deepEqual(ranked.map(item => item.id), services.map(item => item.id));
  assert.equal(ranked[0].selected, true);
  assert.match(ranked[1].reasons[0], /opened the service details/);
  assert.equal(ranked[2].selected, false);
  assert.match(ranked[2].reasons[0], /AI guide; this is not a visitor selection/);
  assert.deepEqual(recordIntent([], 'opened-tool', 'hover'), []);
  assert.deepEqual(recordIntent([], 'opened-tool', 'pageview'), []);
});

test('dismissed suggestions stay dismissed after more AI suggestions and survive session reuse', () => {
  let intent = recordIntent([], 'recommended-tool', 'recommend');
  intent = recordIntent(intent, 'recommended-tool', 'dismiss');
  intent = recordIntent(intent, 'recommended-tool', 'recommend');
  const memory = new Map(), storage = { getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value) };
  saveIntent(intent, storage);
  assert.deepEqual(rankIntent(readIntent(storage), services), []);
  assert.equal(rankIntent(recordIntent(readIntent(storage), 'recommended-tool', 'select'), services)[0].selected, true);
  assert.deepEqual(readIntent({ getItem() { throw new Error('Storage blocked'); } }), []);
});

test('reviewed brief includes interest evidence without promoting it to a selected service or an agreed order', () => {
  const intent = recordIntent(recordIntent([], 'opened-tool', 'read'), 'recommended-tool', 'recommend');
  const message = composeBrief({ challenge: 'Organize the work we do every week.' }, [], rankIntent(intent, services));
  assert.match(message, /Services worth discussing/);
  assert.match(message, /Visitor opened the service details/);
  assert.match(message, /Suggested by the AI guide/);
  assert.match(message, /not an order or agreed scope/);
  const payload = buildInquiry({ name: 'Test visitor', email: 'visitor@example.test', message, confirmed: true, marketingOptIn: false }, [], services, { version: 'test-notice' });
  assert.deepEqual(payload.serviceIds, []);
  assert.equal(payload.message, message);
});
