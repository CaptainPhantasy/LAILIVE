export const BOARD_TIMEZONE = 'America/Indianapolis'
export const BOARD_DEEPSEEK_MODEL = 'deepseek/deepseek-v4.1-flash-1017'
export const BOARD_OUTPUT_LIMIT = 3000

const businessClock = new Intl.DateTimeFormat('en-US', {
  timeZone: BOARD_TIMEZONE, weekday: 'short', hour: 'numeric', hourCycle: 'h23',
})

export function isBoardBusinessHours(time = Date.now()) {
  const parts = Object.fromEntries(businessClock.formatToParts(new Date(time)).map(p => [p.type, p.value]))
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(parts.weekday) && Number(parts.hour) >= 8 && Number(parts.hour) < 17
}

export function boardPolicy(env = process.env, time = Date.now()) {
  const businessHours = isBoardBusinessHours(time)
  return {
    businessHours,
    repeatSessions: businessHours && env.BOARD_REPEAT_SESSIONS === 'true',
    timezone: BOARD_TIMEZONE,
    hours: 'Monday–Friday, 8am–5pm Eastern',
    model: env.BOARD_MODEL || BOARD_DEEPSEEK_MODEL,
    fallbackModels: [],
  }
}

export function boardGenerationOptions(policy) {
  const deepseekRoute = policy.model.startsWith('deepseek/')
  return {
    model: policy.model,
    maxOutputTokens: BOARD_OUTPUT_LIMIT,
    // Keep one provider for reusable prompt prefixes; never silently fall back
    // to the more expensive after-hours models during the DeepSeek window.
    providerOptions: { gateway: {
      caching: 'auto',
      ...(deepseekRoute ? { only: ['deepseek'] } : { models: policy.fallbackModels }),
    } },
    ...(deepseekRoute ? { reasoning: 'none' } : {}),
  }
}

// Only provider-reported charges count as measured cost. Missing usage must
// remain unknown, never zero. No decision text, email, IP, or name is logged.
export function boardUsageRecord(event = {}, policy, time = Date.now()) {
  const usage = event.totalUsage || event.usage || {}
  const gateway = event.providerMetadata?.gateway || {}
  const number = value => (typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value))) && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null
  const costUsd = number(gateway.cost)
  return {
    event: 'board_usage', at: new Date(time).toISOString(),
    requestedModel: policy.model,
    generationId: typeof gateway.generationId === 'string' ? gateway.generationId.slice(0, 150) : null,
    businessHours: policy.businessHours,
    inputTokens: number(usage.inputTokens),
    outputTokens: number(usage.outputTokens),
    cacheReadTokens: number(usage.inputTokenDetails?.cacheReadTokens),
    reasoningTokens: number(usage.outputTokenDetails?.reasoningTokens),
    finishReason: event.finishReason || null,
    costUsd,
    costBasis: costUsd === null ? 'unavailable' : 'gateway-reported',
    withinPennyTarget: costUsd === null ? null : costUsd <= 0.01,
  }
}
