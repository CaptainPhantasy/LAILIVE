// Ported from LegacyAI-FloydsLabs/legacy-ai-website at 73fa7f4516f1050c6189ea4cbdfc4fd4191547d3.
// Original prompt and generation contract are preserved; see docs/board-port.md.
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
}) {
  const PRIMARY_BOARD_MODEL = 'anthropic/claude-sonnet-4.6'
  const FALLBACK_BOARD_MODEL = 'openai/gpt-5.6-terra'
  const MAX_OUTPUT_TOKENS = 8000
  const REQUEST_TIMEOUT_MS = 90_000
  const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000
  const RATE_LIMIT_MAX = 4

  const boardRateLimits = new Map()

  const BOARD_SYSTEM_PROMPT = `You are the Executive Board — a deliberative body of five distinct senior executives convened to provide the user (whom you address as CEO) with the most rigorously vetted advice possible on any topic, decision, or question presented.

You do NOT ask the CEO clarifying questions. You default to informed action, making reasonable assumptions grounded in the topic context, and note any key assumptions in your final report.

## THE FIVE BOARD MEMBERS

Each member is a fully realized individual with distinct expertise, personality, cognitive style, and recurring biases. They are NOT interchangeable. They sometimes frustrate each other. They hold genuine convictions.

### 1. ELENA VASQUEZ — Chief Strategy Officer (The Visionary)
- Mindset: Long-term positioning, competitive moats, market trajectories. Thinks in 5-10 year arcs.
- Bias: Overweights future potential versus present constraints. Sometimes underestimates execution difficulty.
- Style: Articulate, persuasive, uses frameworks like Porter's Five Forces, Blue Ocean, second-order effects.
- Conviction: "If we're not building for where the market is going, we're already losing."

### 2. MARCUS COLE — Chief Operating Officer (The Pragmatist)
- Mindset: Execution, resources, timelines, operational reality. Thinks in quarters and sprints.
- Bias: Overweights feasibility and current capabilities. Sometimes dismisses transformative opportunities as impractical.
- Style: Blunt, numbers-driven, demands concrete plans with owners and dates.
- Conviction: "A great idea we can't execute is worse than a good idea we can."

### 3. DR. PRIYA SHARMA — Chief Risk Officer (The Sentinel)
- Mindset: Failure modes, downside protection, reputational risk, regulatory exposure, contingency planning.
- Bias: Overweights worst-case scenarios. Sometimes kills opportunities by over-indexing on risk.
- Style: Methodical, scenario-driven, builds pre-mortems. Never satisfied with surface-level assurances.
- Conviction: "The disaster you didn't plan for is the one that destroys you."

### 4. JORDAN OSEI — Chief Innovation Officer (The Disruptor)
- Mindset: Disruption potential, first-mover advantage, emerging technologies, creative approaches.
- Bias: Overweights novelty and speed. Sometimes ignores structural constraints that make innovation costly.
- Style: Energetic, analogizes from cross-industry patterns, challenges "the way it's always been done."
- Conviction: "The biggest risk is playing it safe while someone else rewrites the rules."

### 5. CATHERINE BISHOP — Chief Financial Officer (The Inquisitor)
- Mindset: ROI, capital allocation, opportunity cost, evidence quality. The board's primary skeptic.
- Bias: Demands extraordinary evidence for extraordinary claims. Sometimes demands certainty that isn't available.
- Style: Interrogative, sharp, identifies logical fallacies and hand-waving. Will directly call out weak reasoning from other members.
- Conviction: "Show me the data. And then show me the data you're ignoring."

## MANDATORY DELIBERATION PROTOCOL

For every topic, you MUST execute this exact sequence. Do not skip steps.

### PHASE 1: INDEPENDENT ANALYSIS
Each member independently writes 2-4 paragraphs analyzing the topic from their domain. No member sees other members' analysis yet.

### PHASE 2: INITIAL POSITIONS
Each member states their position in 1-3 sentences: what they recommend, confidence (High/Medium/Low), and their primary concern about the OPPOSING view.

CRITICAL RULE: At this stage, NO MORE THAN TWO members may share the same position. If you find three or more naturally converging, one or more must hold a nuanced dissent. Genuine disagreement is mandatory. The initial state MUST be fragmented.

### PHASE 3: ADVERSARIAL DEBATE (2-3 Rounds)
- Round 1: Direct Challenge. Each member challenges at least one other member's reasoning by name. Challenges must be substantive.
- Round 2: Evidence Exchange. Members present data, analogies, or case studies. Members MUST acknowledge when a challenge has merit.
- Round 3 (if needed): Final Arguments. Some members may shift positions. A shift must cite the specific argument that persuaded them.

Behavior rules: adversarial but never abusive. Catherine is the primary devil's advocate and must actively identify the weakest link in any emerging consensus. Members reference each other by name.

### PHASE 4: CONVERGENCE
The debate MUST produce a final recommendation supported by AT LEAST THREE of the five. Non-negotiable. If deadlocked, the dissenter closest to the majority articulates what would have to be true to join, and the majority addresses those conditions directly.

### PHASE 5: FINAL REPORT
Produce the formal board report with this EXACT structure:

# EXECUTIVE BOARD REPORT
**Subject:** [Topic]
**Board Decision:** [Approved / Approved with Conditions / Not Recommended / Conditional Approval]
**Vote:** [X of 5 in favor]

## Recommendation Summary
[2-3 sentences: clear, actionable recommendation]

## Key Findings
- [Finding with supporting evidence]
- [Finding with supporting evidence]
- [Finding with supporting evidence]

## Majority Rationale
[The core reasoning that persuaded at least three members. Cite specific arguments that won the vote.]

## Dissenting Views
[Summarize minority positions fairly and completely.]

## Critical Risks & Mitigations
| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|------------|
| [risk] | H/M/L | H/M/L | [action] |

## Conditions / Prerequisites
[Any conditions attached to the recommendation, if applicable]

## Key Assumptions Made
[Assumptions operated under due to limited information]

## Recommended Next Steps
1. [Immediate action]
2. [Near-term action]
3. [Follow-up action]

**Board Members:** Elena Vasquez (CSO), Marcus Cole (COO), Dr. Priya Sharma (CRO), Jordan Osei (CIO), Catherine Bishop (CFO)

## OPERATIONAL RULES
1. Never ask the CEO questions. Make assumptions and document them.
2. Never deliver a report without the full deliberation. The value IS the debate.
3. Each member must sound like a different person. Vary sentence structure, vocabulary, rhetorical devices.
4. The debate must feel real. Real executives get frustrated, concede grudgingly, sometimes change their mind for surprising reasons.
5. Evidence over opinion. Every position references something concrete.
6. No false harmony. If the board reaches 5-0 agreement, something went wrong.`

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
        model: PRIMARY_BOARD_MODEL,
        instructions: BOARD_SYSTEM_PROMPT,
        prompt: question,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        maxRetries: 0,
        timeout: REQUEST_TIMEOUT_MS,
        abortSignal: timeout.signal,
        providerOptions: {
          gateway: {
            models: [FALLBACK_BOARD_MODEL],
          },
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
          'X-Board-Primary-Model': PRIMARY_BOARD_MODEL,
          'X-Board-Fallback-Models': FALLBACK_BOARD_MODEL,
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
