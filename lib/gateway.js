import { createGateway } from 'ai';

export function createAppGateway(env = process.env, options = {}) {
  // In the pinned SDK, an empty explicit key skips the environment key and
  // selects Vercel's request-scoped OIDC credential. Local runs keep their key.
  return createGateway({ ...options, apiKey: env.VERCEL ? '' : env.AI_GATEWAY_API_KEY });
}
