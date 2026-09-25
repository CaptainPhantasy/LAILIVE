import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHandlers } from '../lib/concierge/handlers.js';
import { consent } from '../lib/concierge/contracts.js';
import { readCatalog } from '../dist/concierge-core.js';
import { loadLeadCatalog } from '../dist/lead-gate.js';

test('actual backend catalog satisfies both public readers with exact approved service content', async () => {
  const approved = JSON.parse(await readFile(new URL('../dist/service-catalog.json', import.meta.url), 'utf8'));
  const forbidden = () => assert.fail('Reading the public catalog must not use storage, owner auth, or generation.');
  const handlers = createHandlers({
    getStore: forbidden, requireOwner: forbidden, generation: new Proxy({}, { get: () => forbidden }),
    // Presence fixtures only: no credentials or external service calls.
    env: { DATABASE_URL: 'configured-test-only', AI_GATEWAY_API_KEY: 'configured-test-only' },
  });
  const fetcher = async (url, options) => {
    assert.equal(url, '/api/concierge/catalog');
    return handlers.catalog(new Request(`https://legacy.example.test${url}`, options));
  };
  const response = await fetcher('/api/concierge/catalog');
  assert.equal(response.status, 200);
  const payload = await response.json();
  const parsed = readCatalog(payload);
  const leadCatalog = await loadLeadCatalog({ fetcher });
  for (const result of [parsed, leadCatalog]) {
    assert.equal(result.services.length, 54);
    assert.deepEqual(result.services, approved.services);
    assert.deepEqual(result.consent, consent);
    assert.deepEqual(result.capabilities, { chat: true, inquiries: true });
  }
  assert.ok(payload.services.every(service => typeof service.description === 'string' && service.description && service.url === `/solutions/#${service.id}`));
});
