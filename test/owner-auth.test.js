import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { createOwnerAuth } from '../lib/concierge/auth.js';

test('Neon EdDSA owner tokens use auth origin for issuer and audience', async () => {
  // Locally signed fixtures only; no real session, provider, or customer data.
  const baseURL = 'https://example.neonauth.test/neondb/auth/';
  const origin = new URL(baseURL).origin;
  const email = 'owner@example.test';
  const keys = await generateKeyPair('EdDSA');
  const verify = createOwnerAuth({ baseURL, email, keys: keys.publicKey });
  const makeToken = (issuer, audience) => new SignJWT({ email, emailVerified: true })
    .setProtectedHeader({ alg: 'EdDSA' }).setSubject('test-owner')
    .setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime('5m')
    .sign(keys.privateKey);
  const request = token => new Request('https://example.test/api/owner/contacts', {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.deepEqual(await verify(request(await makeToken(origin, origin))), {
    subject: 'test-owner', email,
  });
  for (const [issuer, audience] of [[baseURL, origin], [origin, baseURL], ['https://other.test', origin]]) {
    await assert.rejects(verify(request(await makeToken(issuer, audience))), error => error.status === 401);
  }
});
