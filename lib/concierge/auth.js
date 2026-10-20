import { createRemoteJWKSet, jwtVerify } from 'jose';
import { HttpError } from './contracts.js';
import { authBase, ownerEmail } from './config.js';
import { ownerSession } from '../owner-login.js';

export function createOwnerAuth({ baseURL = authBase, email = ownerEmail, keys } = {}) {
  const base = baseURL.replace(/\/$/, '');
  // Neon signs iss/aud with the origin; its JWKS stays under the full auth path.
  const origin = new URL(base).origin;
  const keySet = keys || createRemoteJWKSet(new URL(`${base}/.well-known/jwks.json`), { timeoutDuration: 5000 });
  return async request => {
    // The signed cookie from /api/owner/login opens the workspace on its own. The Neon token
    // below stays supported so an existing session keeps working, but nothing here depends on
    // it: the door no longer needs Google to be reachable.
    const session = ownerSession(request, process.env.RECEPTIONIST_SESSION_SECRET);
    if (session) return { subject: session.subject || 'owner', email };
    const token = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
    if (!token) throw new HttpError(401, 'Sign in to the owner workspace.');
    let payload;
    try { ({ payload } = await jwtVerify(token, keySet, { issuer: origin, audience: origin, algorithms: ['RS256', 'ES256', 'EdDSA'], requiredClaims: ['sub', 'exp', 'iat'] })); }
    catch { throw new HttpError(401, 'Your owner session could not be verified. Sign in again.'); }
    const verified = payload.emailVerified === true || payload.email_verified === true;
    if (typeof payload.sub !== 'string' || !payload.sub.trim() || !verified || typeof payload.email !== 'string' || payload.email.toLowerCase() !== email.toLowerCase()) throw new HttpError(403, 'This account is not authorized for the owner workspace.');
    return { subject: payload.sub, email: payload.email };
  };
}
