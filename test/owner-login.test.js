import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createOwnerLogin, ownerSession, OWNER_COOKIE } from '../lib/owner-login.js';

// The owner door no longer depends on Google: a password is chosen once, authorized by the PIN
// the owner already carries, then exchanged for a signed cookie. These tests hold that line.
test('owner password is chosen with the PIN, exchanged for a cookie, and refused when wrong', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  const salt = '0123456789abcdef0123456789abcdef';
  const env = {
    RECEPTIONIST_SESSION_SECRET: 'test-session-secret-at-least24characters',
    FRONTDESK_OWNER_PIN_HASH: `${salt}:${scryptSync('123456', salt, 32).toString('hex')}`,
  };
  const login = createOwnerLogin({ getDb: () => db, env });
  const post = (body, method = 'POST') => new Request('https://legacyai.space/api/owner/login', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const cookieOf = response => (response.headers.get('set-cookie') || '').split(';')[0];
  try {
    const before = await (await login(new Request('https://legacyai.space/api/owner/login'))).json();
    assert.equal(before.configured, false, 'a fresh workspace must ask the owner to choose a password');
    assert.equal((await login(post({ password: 'correct-horse-staple', pin: '999999' }))).status, 403, 'a wrong PIN must not authorize setup');
    assert.equal((await login(post({ password: 'short', pin: '123456' }))).status, 400, 'too short a password is refused');
    const setup = await login(post({ password: 'correct-horse-staple', pin: '123456' }));
    assert.equal(setup.status, 200);
    const cookie = cookieOf(setup);
    assert.match(cookie, new RegExp(`^${OWNER_COOKIE}=`));
    assert.match(setup.headers.get('set-cookie'), /HttpOnly/);
    assert.equal((await (await login(new Request('https://legacyai.space/api/owner/login'))).json()).configured, true);
    assert.equal((await login(post({ password: 'not-the-password' }))).status, 403);
    const ok = await login(post({ password: 'correct-horse-staple' }));
    assert.equal(ok.status, 200);
    const parsed = ownerSession(new Request('https://legacyai.space/owner', { headers: { cookie: cookieOf(ok) } }), env.RECEPTIONIST_SESSION_SECRET);
    assert.equal(parsed?.scope, 'owner-workspace');
    assert.equal(ownerSession(new Request('https://legacyai.space/owner', { headers: { cookie: `${OWNER_COOKIE}=forged` } }), env.RECEPTIONIST_SESSION_SECRET), null);
    const out = await login(new Request('https://legacyai.space/api/owner/login', { method: 'DELETE', headers: { cookie: cookieOf(ok) } }));
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await login(post({}, 'PUT'))).status, 405);
  } finally { await pg.close(); }
});
