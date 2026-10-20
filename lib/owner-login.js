import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { signOwnerToken, readOwnerToken, verifyOwnerPin } from './owner-documents-core.js';
import { ownerPinHash } from './owner-pin.js';

// The owner door used to depend on Google through Neon Auth. That put a third party between
// Douglas and his own records: when the callback URL was missing from the provider's allow
// list the door simply did not open. This is the replacement — a password only he holds,
// stored as a scrypt hash, exchanged for a signed cookie. No provider, no redirect, no
// account anywhere else.
export const OWNER_COOKIE = 'legacy_owner_session';
const SESSION_MS = 7 * 86400000;
const MAX_FAILURES_PER_HOUR = 10;
const MIN_PASSWORD = 10;
const MAX_PASSWORD = 200;

const json = (value, status = 200, headers = {}) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
const readCookie = (request, name) => {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    if (part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return '';
};
// Same encoded shape owner-documents-core.verifyOwnerPin already reads: "salt:hex".
const encode = password => {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(String(password), salt, 32).toString('hex')}`;
};
const matches = (password, encoded) => {
  if (typeof encoded !== 'string' || !encoded.includes(':')) return false;
  const [salt, hex] = encoded.split(':');
  let actual;
  try { actual = scryptSync(String(password), salt, 32); } catch { return false; }
  const expected = Buffer.from(hex, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};
const cookieHeader = (value, maxAgeSeconds) => `${OWNER_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;

export function ownerSession(request, secret, now = Date.now()) {
  const session = readOwnerToken(readCookie(request, OWNER_COOKIE), secret, now);
  return session?.scope === 'owner-workspace' ? session : null;
}

export function createOwnerLogin({ getDb, env = process.env, now = Date.now } = {}) {
  const db = () => getDb();
  let ready;
  const ensure = async () => ready ||= (async () => {
    await db().execute(sql.raw('CREATE TABLE IF NOT EXISTS legacy_owner_login (id text PRIMARY KEY, password_hash text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())'));
    await db().execute(sql.raw('CREATE TABLE IF NOT EXISTS legacy_owner_login_attempts (id bigserial PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now())'));
    await db().execute(sql.raw('ALTER TABLE legacy_owner_login ENABLE ROW LEVEL SECURITY'));
    await db().execute(sql.raw('ALTER TABLE legacy_owner_login_attempts ENABLE ROW LEVEL SECURITY'));
  })().catch(error => { ready = null; throw error; });
  const current = async () => (await db().execute(sql`SELECT password_hash FROM legacy_owner_login WHERE id='owner'`)).rows[0]?.password_hash || '';
  const failuresLastHour = async () => Number((await db().execute(sql`SELECT count(*)::int AS n FROM legacy_owner_login_attempts WHERE created_at > now() - interval '1 hour'`)).rows[0]?.n || 0);
  const recordFailure = () => db().execute(sql`INSERT INTO legacy_owner_login_attempts DEFAULT VALUES`).catch(() => {});

  return async request => {
    try {
      await ensure();
      if (request.method === 'GET') return json({ configured: Boolean(await current()) });
      if (request.method === 'DELETE') return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader('', 0) });
      if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
      if (!env.RECEPTIONIST_SESSION_SECRET) return json({ error: 'Owner sign-in is not configured.' }, 503);
      if (await failuresLastHour() >= MAX_FAILURES_PER_HOUR) return json({ error: 'Too many attempts. Wait an hour.' }, 429);
      const raw = await request.text();
      if (Buffer.byteLength(raw) > 4000) return json({ error: 'Too large.' }, 413);
      const body = JSON.parse(raw || '{}');
      const password = typeof body.password === 'string' ? body.password : '';
      const stored = await current();
      if (!stored) {
        // First run: the owner chooses the password. The PIN he already has authorizes the
        // one-time setup, so nobody who reaches this page first can claim the workspace.
        if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) return json({ error: `Choose a password between ${MIN_PASSWORD} and ${MAX_PASSWORD} characters.` }, 400);
        const pin = String(body.pin || '');
        const configuredPin = (await ownerPinHash(db())) || env.FRONTDESK_OWNER_PIN_HASH;
        if (!configuredPin) return { ...json({ error: 'Set the phone PIN before choosing a password.' }, 409) };
        if (!verifyOwnerPin(pin, configuredPin)) { await recordFailure(); return json({ error: 'That PIN did not match.' }, 403); }
        await db().execute(sql`INSERT INTO legacy_owner_login (id, password_hash) VALUES ('owner', ${encode(password)}) ON CONFLICT (id) DO NOTHING`);
        if (!(await current())) return json({ error: 'The password could not be saved.' }, 500);
      } else if (!matches(password, stored)) {
        await recordFailure();
        return json({ error: 'That password did not match.' }, 403);
      }
      const session = signOwnerToken({ subject: 'owner', scope: 'owner-workspace', exp: now() + SESSION_MS }, env.RECEPTIONIST_SESSION_SECRET);
      return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader(session, Math.floor(SESSION_MS / 1000)) });
    } catch { return json({ error: 'Owner sign-in failed.' }, 500); }
  };
}
