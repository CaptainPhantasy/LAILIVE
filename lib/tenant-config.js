import { sql } from 'drizzle-orm';
import { frontdeskSecret } from './frontdesk.js';
import { secretMatches } from './assistant.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const str = (value, min = 1, max = 200) => typeof value === 'string' && value.trim().length >= min && value.trim().length <= max ? value.trim() : '';
const placeholders = /^(tbd|todo|n\/a|na|xxx+|placeholder|change me)$/i;
const httpsUrl = value => { try { const url = new URL(String(value)); return url.protocol === 'https:'; } catch { return false; } };

// Validates the six intake inputs before a client is provisioned. Facts must be
// supplied by the owner; placeholders are refused rather than provisioned.
export function validateTenant(input) {
  const errors = [];
  const tenant = input && typeof input === 'object' ? input : {};
  const business = tenant.business || {}, routing = tenant.routing || {}, pricing = tenant.pricing || {}, warranty = tenant.warranty || {}, assets = tenant.assets || {};
  const slug = str(tenant.slug, 2, 40);
  if (!/^[a-z0-9-]{2,40}$/.test(slug)) errors.push('slug must be lowercase letters, numbers, or hyphens (2-40 characters).');
  for (const [field, label] of [['legal_name', 'legal name'], ['trade', 'trade']]) {
    const value = str(business[field], 2, 120);
    if (!value || placeholders.test(value)) errors.push(`${label} is required and cannot be a placeholder.`);
  }
  const areas = Array.isArray(business.service_area) ? business.service_area.map(value => str(value, 2, 120)).filter(Boolean) : [];
  if (!areas.length) errors.push('At least one service area is required.');
  if (areas.some(value => placeholders.test(value))) errors.push('Service areas cannot be placeholders.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(routing.owner_email || ''))) errors.push('owner_email must be a valid email address.');
  if (!/^\+1\d{10}$/.test(String(routing.owner_cell || ''))) errors.push('owner_cell must be an E.164 US number like +18123405761.');
  if (!/^\d{10}$/.test(String(routing.public_phone || '').replace(/\D/g, ''))) errors.push('public_phone must contain 10 digits.');
  const carrier = str(routing.carrier, 2, 60);
  if (!carrier || placeholders.test(carrier)) errors.push('carrier is required for call forwarding.');
  const freeEstimate = pricing.free_estimate === true;
  const fee = pricing.diagnostic_fee_cents;
  if (!freeEstimate && !(Number.isSafeInteger(fee) && fee >= 0)) errors.push('Set a diagnostic fee in cents or mark free_estimate true.');
  const services = Array.isArray(pricing.services) ? pricing.services : [];
  if (!services.length) errors.push('At least one service with a base price is required.');
  // The saved configuration keeps every service, so every service is validated.
  if (services.length > 10) errors.push('At most 10 services are allowed.');
  for (const [index, service] of services.entries()) {
    if (!str(service?.name, 2, 120)) errors.push(`service ${index + 1} needs a name.`);
    if (!Number.isSafeInteger(service?.price_cents) || service.price_cents < 0 || service.price_cents > 100000000) errors.push(`service ${index + 1} needs a price in cents.`);
  }
  if (str(pricing.hours, 2, 200).length < 2) errors.push('hours are required.');
  if (str(pricing.emergency_definition, 10, 500).length < 10) errors.push('emergency_definition must be at least 10 characters.');
  if (str(warranty.text, 5, 500).length < 5) errors.push('warranty text is required.');
  const payment = String(warranty.payment_link || '');
  if (payment && payment !== 'on completion' && !httpsUrl(payment)) errors.push('payment_link must be an https URL or "on completion".');
  if (assets.logo_url && !httpsUrl(assets.logo_url)) errors.push('logo_url must be an https URL.');
  if (assets.photo_url && !httpsUrl(assets.photo_url)) errors.push('photo_url must be an https URL.');
  return { ok: errors.length === 0, errors };
}

export function createTenantHandler({ getDb, env = process.env } = {}) {
  const db = () => getDb();
  let ready;
  const ensure = () => ready ||= (async () => {
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_tenants (slug text PRIMARY KEY, config jsonb NOT NULL, status text NOT NULL DEFAULT 'ready', updated_at timestamptz NOT NULL DEFAULT now())`));
    await db().execute(sql.raw('ALTER TABLE legacy_tenants ENABLE ROW LEVEL SECURITY'));
  })().catch(error => { ready = null; throw error; });

  return async request => {
    try {
      await ensure();
      if (request.method !== 'POST') return json({ error: 'POST required.' }, 405);
      if (!env.TENANT_SECRET && !env.RECEPTIONIST_WEBHOOK_SECRET) return json({ error: 'Not authorized.' }, 401);
      if (!frontdeskSecret(request).some(value => secretMatches(value, env.TENANT_SECRET || env.RECEPTIONIST_WEBHOOK_SECRET))) return json({ error: 'Not authorized.' }, 401);
      const raw = await request.text();
      if (Buffer.byteLength(raw) > 20000) return json({ error: 'Too large.' }, 413);
      const input = JSON.parse(raw);
      if (input.action === 'get') {
        const slug = String(input.slug || '');
        const row = (await db().execute(sql`SELECT config,status,updated_at FROM legacy_tenants WHERE slug=${slug}`)).rows[0];
        return row ? json({ ok: true, ...row }) : json({ error: 'No client with that slug.' }, 404);
      }
      if (input.action === 'validate') return json(validateTenant(input.tenant));
      if (input.action && input.action !== 'save') return json({ error: 'Unknown action.' }, 400);
      const checked = validateTenant(input.tenant);
      if (!checked.ok) return json(checked, 400);
      const slug = input.tenant.slug;
      await db().execute(sql`INSERT INTO legacy_tenants(slug,config,status) VALUES (${slug},${JSON.stringify(input.tenant)}::jsonb,'ready') ON CONFLICT (slug) DO UPDATE SET config=${JSON.stringify(input.tenant)}::jsonb,status='ready',updated_at=now()`);
      return json({ ok: true, slug, status: 'ready' });
    } catch { return json({ error: 'The client configuration could not be completed.' }, 500); }
  };
}
