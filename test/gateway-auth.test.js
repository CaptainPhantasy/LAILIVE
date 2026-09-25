import test from 'node:test';
import assert from 'node:assert/strict';
import { generateText } from 'ai';
import { createAppGateway } from '../lib/gateway.js';

test('pinned Gateway SDK selects native OIDC on Vercel and explicit keys locally', async t => {
  const names = ['VERCEL', 'VERCEL_OIDC_TOKEN', 'AI_GATEWAY_API_KEY'];
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => {
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  });
  // A deliberately unsigned local fixture satisfies the SDK's expiry parser.
  // The captured transport never sends it to any service.
  const oidcFixture = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture`;
  process.env.VERCEL_OIDC_TOKEN = oidcFixture;
  process.env.AI_GATEWAY_API_KEY = 'fixture-stored-api-key';
  for (const deployed of [true, false]) {
    if (deployed) process.env.VERCEL = '1';
    else delete process.env.VERCEL;
    const captured = [];
    const gateway = createAppGateway(process.env, {
      fetch: async (_url, options) => {
        captured.push(new Headers(options.headers));
        // Stop at the transport boundary: no network or generated content.
        return Response.json({ error: { message: 'Test transport stopped', type: 'authentication_error' } }, { status: 401 });
      },
    });
    await assert.rejects(generateText({ model: gateway('anthropic/claude-sonnet-4.6'), prompt: 'Credential selection test', maxRetries: 0 }));
    assert.equal(captured.length, 1);
    assert.equal(captured[0].get('authorization'), `Bearer ${deployed ? oidcFixture : 'fixture-stored-api-key'}`);
    if (deployed) assert.notEqual(captured[0].get('authorization'), `Bearer ${process.env.AI_GATEWAY_API_KEY}`);
  }
});
