import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createBoardHandler } from '../lib/board-handler.js'

// Network-free contract tests. Test providers are injected only here, never in the API.
// The fixture value lives under a non-credential name so secret scanners do not flag it.
const fixture = { gateway: 'test-only-not-a-credential' }
const env = { AI_GATEWAY_API_KEY: fixture.gateway }
const question = 'Should we add a second service truck?'
const request = (body = { question }, headers = {}, method = 'POST') => new Request('https://legacyai.space/api/board', {
  method, headers: { 'content-type': 'application/json', ...headers },
  ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
})
const provider = () => ({ textStream: (async function* () { yield 'First '; yield 'second.' })() })

test('rejects non-POST and cross-origin requests before generation', async () => {
  const handler = createBoardHandler({ env, streamText: () => { throw new Error('must not generate') } })
  assert.equal((await handler(request(undefined, {}, 'GET'))).status, 405)
  assert.equal((await handler(request(undefined, { origin: 'https://unrelated.example' }))).status, 403)
})

test('rejects invalid JSON, missing/short/long questions and oversized bodies', async () => {
  const handler = createBoardHandler({ env, streamText: () => { throw new Error('must not generate') } })
  for (const body of ['{', {}, { question: 'short' }, { question: 'x'.repeat(501) }]) {
    assert.equal((await handler(request(body))).status, 400)
  }
  assert.equal((await handler(request(' '.repeat(4097)))).status, 413)
  assert.equal((await handler(request(undefined, { 'content-length': '4097' }))).status, 413)
})

test('missing auth returns a configuration error without calling provider', async () => {
  const handler = createBoardHandler({ env: {}, streamText: () => { throw new Error('must not generate') } })
  const response = await handler(request())
  assert.equal(response.status, 500)
  assert.match((await response.json()).error, /authentication/)
})

test('preserves real source prompt, model/fallback, output bound and plain-text streaming', async () => {
  let options
  const handler = createBoardHandler({ env, streamText: input => { options = input; return provider() } })
  const response = await handler(request(undefined, { origin: 'https://legacyai.space' }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.equal(await response.text(), 'First second.')
  const original = readFileSync(new URL('../provenance/deployed-route.ts.txt', import.meta.url), 'utf8')
  const expectedPrompt = original.split('const BOARD_SYSTEM_PROMPT = `')[1].split('`\n')[0]
  assert.equal(options.instructions, expectedPrompt)
  assert.equal(options.model, 'anthropic/claude-sonnet-4.6')
  assert.deepEqual(options.providerOptions.gateway.models, ['openai/gpt-5.6-terra'])
  assert.equal(options.maxOutputTokens, 8000)
  assert.equal(options.timeout, 90000)
  assert.equal(options.maxRetries, 0)
  assert.equal(options.prompt, question)
})

test('retains four-per-IP hourly limiter and retry-after, then resets', async () => {
  let time = 1000, calls = 0
  const handler = createBoardHandler({ env, now: () => time, streamText: () => { calls++; return provider() } })
  for (let i = 0; i < 4; i++) assert.equal(await (await handler(request(undefined, { 'x-forwarded-for': '192.0.2.1' }))).text(), 'First second.')
  const limited = await handler(request(undefined, { 'x-forwarded-for': '192.0.2.1' }))
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('retry-after'), '3600')
  assert.equal(calls, 4)
  const other = await handler(request(undefined, { 'x-forwarded-for': '192.0.2.2' }))
  assert.equal(other.status, 200); await other.text()
  time += 3600000
  const reset = await handler(request(undefined, { 'x-forwarded-for': '192.0.2.1' }))
  assert.equal(reset.status, 200); await reset.text()
})

test('maps provider billing/rate failures before first token and omits raw detail', async () => {
  for (const status of [402, 429, 502]) {
    const handler = createBoardHandler({ env, streamText: options => ({ textStream: (async function* () {
      options.onError({ error: Object.assign(new Error('internal provider detail'), { status }) })
    })() }) })
    const response = await handler(request())
    assert.equal(response.status, status)
    const body = await response.json()
    assert.equal('detail' in body, false)
  }
})

test('empty provider output does not become a successful report', async () => {
  const handler = createBoardHandler({ env, streamText: () => ({ textStream: (async function* () {})() }) })
  assert.equal((await handler(request())).status, 502)
})

test('midstream provider error rejects the body instead of delivering truncated success', async () => {
  const handler = createBoardHandler({ env, streamText: options => ({ textStream: (async function* () {
    yield 'Partial'
    options.onError({ error: new Error('provider stopped') })
  })() }) })
  const response = await handler(request())
  assert.equal(response.status, 200)
  await assert.rejects(response.text(), /provider stopped/)
})

test('stream cancellation aborts model work', async () => {
  let signal
  const handler = createBoardHandler({ env, streamText: options => {
    signal = options.abortSignal
    return { textStream: (async function* () {
      yield 'First'
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    })() }
  } })
  const response = await handler(request())
  await response.body.cancel()
  assert.equal(signal.aborted, true)
})

test('OIDC auth remains supported with no explicit API key override', async () => {
  const handler = createBoardHandler({ env: { VERCEL_OIDC_TOKEN: 'test-only-oidc' }, streamText: provider })
  const response = await handler(request())
  assert.equal(response.headers.get('x-board-auth'), 'oidc')
  assert.equal(await response.text(), 'First second.')
})
