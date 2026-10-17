// Ported from LegacyAI-FloydsLabs/legacy-ai-website at 73fa7f4516f1050c6189ea4cbdfc4fd4191547d3.
// Original transport contract is preserved; see docs/board-port.md.
import { BOARD_SYSTEM_PROMPT } from './board-prompt.js'
import { boardPolicy, boardGenerationOptions, boardUsageRecord } from './board-policy.js'
async function readBoundedText(request) {
  const reader = request.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let length = 0,
    text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > 4096) {
        await reader.cancel()
        throw Object.assign(new Error('Request body too large.'), {
          status: 413,
        })
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

export function createBoardHandler({
  streamText,
  env = process.env,
  now = Date.now,
  onUsage = record => console.info(JSON.stringify(record)),
}) {
  const REQUEST_TIMEOUT_MS = 90_000
  const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000
  const RATE_LIMIT_MAX = 4

  const boardRateLimits = new Map()

  function jsonError(error, status) {
    return new Response(JSON.stringify({ error }), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  }

  function getClientKey(req) {
    const forwardedFor = req.headers
      .get('x-forwarded-for')
      ?.split(',')[0]
      ?.trim()
    return forwardedFor || req.headers.get('x-real-ip') || 'unknown'
  }

  function rateLimitResponse(req) {
    const currentTime = now()
    const key = getClientKey(req)

    for (const [bucketKey, bucket] of boardRateLimits) {
      if (bucket.resetAt <= currentTime) boardRateLimits.delete(bucketKey)
    }

    const bucket = boardRateLimits.get(key)
    if (!bucket || bucket.resetAt <= currentTime) {
      boardRateLimits.set(key, {
        count: 1,
        resetAt: currentTime + RATE_LIMIT_WINDOW_MS,
      })
      return null
    }

    if (bucket.count >= RATE_LIMIT_MAX) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((bucket.resetAt - currentTime) / 1000),
      )
      return new Response(
        JSON.stringify({
          error:
            'The board is receiving too many requests. Please try again shortly.',
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(retryAfterSeconds),
          },
        },
      )
    }

    bucket.count += 1
    return null
  }

  function gatewayErrorStatus(error) {
    const maybeStatus =
      error && typeof error === 'object'
        ? Number(error.status ?? error.statusCode)
        : Number.NaN
    const message = error instanceof Error ? error.message : String(error)

    if (
      maybeStatus === 402 ||
      /(^|\D)402(\D|$)|payment|required|credit|quota/i.test(message)
    )
      return 402
    if (
      maybeStatus === 429 ||
      /(^|\D)429(\D|$)|rate.?limit|too many requests/i.test(message)
    )
      return 429
    if (maybeStatus >= 400 && maybeStatus < 500) return maybeStatus
    return 502
  }

  function gatewayErrorMessage(status) {
    if (status === 402)
      return 'The board could not convene because Gateway billing or credits require attention.'
    if (status === 429)
      return 'The board is temporarily rate limited by the model provider. Please try again shortly.'
    return 'The board could not convene because the model provider failed.'
  }

  async function firstTextChunk(iterator) {
    return iterator.next()
  }

  async function POST(req) {
    const policy = boardPolicy(env, now())
    if (req.method === 'GET') return Response.json({
      repeatSessions: policy.repeatSessions, hours: policy.hours, timezone: policy.timezone,
    }, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
    if (req.method !== 'POST') return jsonError('Method not allowed.', 405)
    const origin = req.headers.get('Origin')
    if (origin && origin !== new URL(req.url).origin)
      return jsonError('This request must come from the Board page.', 403)
    if (Number(req.headers.get('Content-Length') || 0) > 4096)
      return jsonError('Please shorten your decision.', 413)
    let body
    try {
      body = JSON.parse(await readBoundedText(req))
    } catch (error) {
      if (error?.status === 413)
        return jsonError('Please shorten your decision.', 413)
      return jsonError('Invalid request body.', 400)
    }

    const question =
      body &&
      typeof body === 'object' &&
      'question' in body &&
      typeof body.question === 'string'
        ? body.question.trim()
        : ''

    if (question.length < 8 || question.length > 500) {
      return jsonError(
        'Please describe the decision in 8 to 500 characters.',
        400,
      )
    }

    // A page opened before closing time must not turn a repeat session into
    // an unplanned premium-model request once business hours have ended.
    if (body?.repeatSession === true && !policy.repeatSessions) {
      return jsonError('Additional Board sessions are available during business hours when enabled. Please return then or talk with Douglas about your next decision.', 403)
    }

    const limited = rateLimitResponse(req)
    if (limited) return limited

    // The API adapter selects native OIDC on Vercel and an explicit key locally.
    if (!env.VERCEL && !env.AI_GATEWAY_API_KEY && !env.VERCEL_OIDC_TOKEN) {
      return jsonError(
        'Board is misconfigured: missing Vercel AI Gateway authentication.',
        500,
      )
    }

    const timeout = new AbortController()
    const timeoutId = setTimeout(
      () => timeout.abort('Board request timed out.'),
      REQUEST_TIMEOUT_MS,
    )

    // In AI SDK v7, streamText does not throw model/Gateway errors from the call
    // itself, and `textStream` deliberately omits error parts (only network-level
    // errors that stop the stream propagate). Errors are instead delivered to the
    // `onError` callback. We capture them here so that (1) failures before the
    // first token can be re-thrown into the outer catch for correct status mapping
    // (402/429/etc.) and (2) mid-stream failures abort the ReadableStream instead
    // of being silently truncated into a "successful" 200 response.
    let streamError = null

    try {
      const result = streamText({
        ...boardGenerationOptions(policy),
        instructions: BOARD_SYSTEM_PROMPT,
        prompt: question,
        maxRetries: 0,
        timeout: REQUEST_TIMEOUT_MS,
        abortSignal: timeout.signal,
        onFinish: async event => {
          try { await onUsage(boardUsageRecord(event, policy, now())) } catch { /* Telemetry must not break delivery. */ }
          if (event.finishReason === 'length') streamError = new Error('The Board report reached its length limit. Please try a narrower decision.')
        },
        onError: ({ error }) => {
          streamError = error
        },
      })

      const iterator = result.textStream[Symbol.asyncIterator]()
      const firstChunk = await firstTextChunk(iterator)

      if (streamError) {
        // A model/Gateway error surfaced before any text was produced. Re-throw so
        // the outer catch can map it to the correct status (402/429/4xx/502).
        throw streamError
      }

      if (firstChunk.done) {
        clearTimeout(timeoutId)
        return jsonError(
          'The board could not convene because the model provider returned an empty stream.',
          502,
        )
      }

      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode(firstChunk.value))
          try {
            while (true) {
              const next = await iterator.next()
              if (next.done) break
              controller.enqueue(encoder.encode(next.value))
            }
            if (streamError) {
              // A model/Gateway error surfaced mid-stream. Abort so the client sees
              // a failure rather than a truncated report presented as complete.
              controller.error(streamError)
            } else {
              controller.close()
            }
          } catch (error) {
            controller.error(error)
          } finally {
            clearTimeout(timeoutId)
          }
        },
        cancel() {
          clearTimeout(timeoutId)
          timeout.abort('Board stream cancelled by client.')
        },
      })

      return new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
          'X-Content-Type-Options': 'nosniff',
          'X-Board-Primary-Model': policy.model,
          'X-Board-Fallback-Models': policy.fallbackModels.join(','),
          'X-Board-Repeat-Sessions': String(policy.repeatSessions),
          'X-Board-Auth': env.VERCEL || !env.AI_GATEWAY_API_KEY ? 'oidc' : 'api-key',
        },
      })
    } catch (error) {
      clearTimeout(timeoutId)
      const status = gatewayErrorStatus(error)
      return jsonError(gatewayErrorMessage(status), status)
    }
  }

  return POST
}
