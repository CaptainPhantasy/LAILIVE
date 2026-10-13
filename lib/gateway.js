import { createGateway } from 'ai';

export function createAppGateway(env = process.env, options = {}) {
  // In the pinned SDK, an empty explicit key skips the environment key and
  // selects Vercel's request-scoped OIDC credential. Local runs keep their key.
  return createGateway({ ...options, apiKey: env.VERCEL ? '' : env.AI_GATEWAY_API_KEY });
}

// Single source of truth for the Gateway provider options every model call
// sends. `caching: 'auto'` has the Gateway place the prompt-cache breakpoints
// providers such as Anthropic require; providers that cache implicitly ignore
// it. Extra Gateway keys, such as the Board's fallback `models`, merge in here.
export function gatewayProviderOptions({ gateway = {} } = {}) {
  return { gateway: { caching: 'auto', ...gateway } };
}
