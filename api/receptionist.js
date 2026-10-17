import { generateText, Output } from 'ai';
import { receptionistInstructions, receptionistOutput } from '../lib/receptionist.js';
import { createAppGateway, gatewayProviderOptions } from '../lib/gateway.js';
import { model } from '../lib/concierge/config.js';
import { HttpError } from '../lib/concierge/contracts.js';

const gateway = createAppGateway();

// The hosted native voice demo replaces the custom AI Chat turn endpoint, so the
// default fetch stays a clear 503. The generator remains exported for call-site
// tests and for any surface that chooses to reuse it.
export async function generate(input) {
  if (!process.env.VERCEL && !process.env.AI_GATEWAY_API_KEY && !process.env.VERCEL_OIDC_TOKEN) throw new HttpError(503, 'The receptionist is not connected yet. Please try again later.');
  const messages = input.messages.map(m => ({ role: m.role === 'caller' ? 'user' : 'assistant', content: m.content }));
  const result = await generateText({
    model: gateway(process.env.RECEPTIONIST_MODEL || model), maxOutputTokens: 700, maxRetries: 0, timeout: 30000, providerOptions: gatewayProviderOptions(),
    instructions: receptionistInstructions(input),
    ...(messages.length ? { messages } : { prompt: '(The phone is ringing. Answer it.)' }),
    output: Output.object({ schema: receptionistOutput }),
  });
  return result.output;
}

export default { fetch: () => Response.json({ error: 'This preview demo uses browser voice. Start the call on the receptionist page.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }) };
