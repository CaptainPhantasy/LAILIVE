import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createTenantHandler, validateTenant } from '../lib/tenant-config.js';

const env = { TENANT_SECRET: 'tenant-secret' };
const valid = {
  slug: 'acme-plumbing',
  business: { legal_name: 'Acme Plumbing LLC', dba: '', trade: 'Plumbing', service_area: ['Indianapolis', 'Carmel'] },
  routing: { owner_email: 'owner@acme.example', owner_cell: '+13175550123', public_phone: '3175550199', carrier: 'Verizon' },
  pricing: { free_estimate: false, diagnostic_fee_cents: 8900, services: [{ name: 'Water heater replacement', price_cents: 185000 }], hours: 'Mon-Fri 7am-5pm', emergency_definition: 'No water or active flooding that cannot be shut off.' },
  warranty: { text: 'One-year parts and labor.', payment_link: 'on completion' },
  assets: { logo_url: 'https://acme.example/logo.png' },
};
const post = (body, secret = 'tenant-secret') => new Request('https://legacyai.space/api/frontdesk/tenants', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-frontdesk-secret': secret }, body: JSON.stringify(body),
});

test('a complete client file passes and placeholders are refused', () => {
  assert.equal(validateTenant(valid).ok, true);
  const missing = validateTenant({ slug: 'x' });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.length >= 5);
  const placeholder = validateTenant({ ...valid, business: { ...valid.business, legal_name: 'TBD' } });
  assert.equal(placeholder.ok, false);
  assert.match(placeholder.errors.join(' '), /legal name/);
  assert.equal(validateTenant({ ...valid, routing: { ...valid.routing, owner_cell: '3175550123' } }).ok, false);
  assert.equal(validateTenant({ ...valid, routing: { ...valid.routing, owner_email: 'not-an-email' } }).ok, false);
  assert.equal(validateTenant({ ...valid, pricing: { ...valid.pricing, services: [] } }).ok, false);
  assert.equal(validateTenant({ ...valid, pricing: { ...valid.pricing, free_estimate: undefined, diagnostic_fee_cents: undefined } }).ok, false);
  assert.equal(validateTenant({ ...valid, pricing: { ...valid.pricing, free_estimate: true, diagnostic_fee_cents: undefined } }).ok, true);
});

test('a valid client is stored and can be read back', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  const handler = createTenantHandler({ getDb: () => db, env });
  try {
    assert.equal((await handler(post({ action: 'save', tenant: valid }, 'wrong'))).status, 401);
    const saved = await (await handler(post({ action: 'save', tenant: valid }))).json();
    assert.equal(saved.slug, 'acme-plumbing');
    const got = await (await handler(post({ action: 'get', slug: 'acme-plumbing' }))).json();
    assert.equal(got.ok, true);
    assert.equal(got.config.business.legal_name, 'Acme Plumbing LLC');
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM legacy_tenants')).rows[0].n, 1);
    await handler(post({ action: 'save', tenant: { ...valid, pricing: { ...valid.pricing, diagnostic_fee_cents: 9900 } } }));
    const updated = await (await handler(post({ action: 'get', slug: 'acme-plumbing' }))).json();
    assert.equal(updated.config.pricing.diagnostic_fee_cents, 9900);
  } finally { await pg.close(); }
});

test('an invalid client is refused on save and unknown slugs return 404', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  const handler = createTenantHandler({ getDb: () => db, env });
  try {
    const response = await handler(post({ action: 'save', tenant: { slug: 'acme', business: {} } }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).ok, false);
    assert.equal((await handler(post({ action: 'get', slug: 'nobody' }))).status, 404);
    assert.equal((await handler(post({ action: 'nope' }))).status, 400);
  } finally { await pg.close(); }
});
