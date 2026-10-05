import { createReceptionistSpeech } from '../lib/receptionist-voice.js';
import { generateText, Output } from 'ai';
import { createReceptionistHandler, receptionistInstructions, receptionistOutput } from '../lib/receptionist.js';
import { getStore } from '../lib/concierge/database.js';
import { createAppGateway } from '../lib/gateway.js';
import { model } from '../lib/concierge/config.js';
import { HttpError } from '../lib/concierge/contracts.js';

const gateway = createAppGateway();
async function generate(input) {
  if (!process.env.VERCEL && !process.env.AI_GATEWAY_API_KEY && !process.env.VERCEL_OIDC_TOKEN) throw new HttpError(503, 'The receptionist is not connected yet. Please try again later.');
  const messages = input.messages.map(m => ({ role: m.role === 'caller' ? 'user' : 'assistant', content: m.content }));
  const result = await generateText({
    model: gateway(process.env.RECEPTIONIST_MODEL || model), maxOutputTokens: 700, maxRetries: 0, timeout: 30000,
    instructions: receptionistInstructions(input),
    ...(messages.length ? { messages } : { prompt: '(The phone is ringing. Answer it.)' }),
    output: Output.object({ schema: receptionistOutput }),
  });
  return result.output;
}
export default { fetch: createReceptionistHandler({ generate, getStore, generateSpeech: createReceptionistSpeech() }) };
