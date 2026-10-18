import { generateText } from 'ai';
import { BOARD_SYSTEM_PROMPT } from './board-prompt.js';
import { boardPolicy, boardGenerationOptions, boardUsageRecord } from './board-policy.js';
import { createAppGateway } from './gateway.js';

// The Board web route streams; the owner review page needs one complete memo it
// can store as a draft, render as a PDF, and email. This uses the same prompt,
// model policy, token limit and usage record as the public Board.
export function createBoardGenerator({ env = process.env, generate = generateText, gateway = createAppGateway(env), now = Date.now, onUsage = record => console.info(JSON.stringify(record)) } = {}) {
  return async function generateBoard(question) {
    if (typeof question !== 'string' || question.trim().length < 8) throw new Error('A Board question is required.');
    if (!env.VERCEL && !env.AI_GATEWAY_API_KEY && !env.VERCEL_OIDC_TOKEN) throw new Error('Board is not connected.');
    const policy = boardPolicy(env, now());
    const options = boardGenerationOptions(policy);
    const result = await generate({
      ...options,
      model: gateway(options.model),
      instructions: BOARD_SYSTEM_PROMPT,
      prompt: question.trim(),
      maxRetries: 0,
      timeout: 90000,
      onFinish: async event => {
        try { await onUsage(boardUsageRecord(event, policy, now())) } catch { /* telemetry must not break delivery */ }
      },
    });
    const text = String(result.text || '').trim();
    if (!text) throw new Error('The Board returned an empty report.');
    return text;
  };
}
