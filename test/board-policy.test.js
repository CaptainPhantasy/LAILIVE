import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { streamText } from 'ai'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { boardPolicy, boardGenerationOptions, boardUsageRecord, isBoardBusinessHours } from '../lib/board-policy.js'
import { createBoardHandler } from '../lib/board-handler.js'

const env = { AI_GATEWAY_API_KEY: 'test-only-not-a-credential', BOARD_REPEAT_SESSIONS: 'true' }
const monday = Date.parse('2026-10-19T12:00:00Z')
const post = question => new Request('https://example.test/api/board', { method: 'POST', body: JSON.stringify({ question }) })

test('Board model overrides use their own provider rather than the DeepSeek filter', () => {
  for (const model of ['anthropic/claude-sonnet-4.6', 'openai/gpt-5']) {
    const policy = boardPolicy({ BOARD_MODEL: model }, monday)
    assert.equal(policy.model, model)
    const options = boardGenerationOptions(policy)
    assert.equal(options.providerOptions.gateway.only, undefined)
    assert.equal(options.reasoning, undefined)
  }
  const options = boardGenerationOptions(boardPolicy({ BOARD_MODEL: 'deepseek/another-model' }, monday))
  assert.deepEqual(options.providerOptions.gateway.only, ['deepseek'])
})

test('Indiana business clock handles exact boundaries, weekends and daylight saving', () => {
  for (const [date, expected] of [
    ['2026-10-19T11:59:59Z', false], ['2026-10-19T12:00:00Z', true],
    ['2026-10-19T20:59:59Z', true], ['2026-10-19T21:00:00Z', false],
    ['2026-10-17T16:00:00Z', false], ['2026-10-18T16:00:00Z', false],
    ['2026-12-07T12:59:59Z', false], ['2026-12-07T13:00:00Z', true],
    ['2026-12-07T21:59:59Z', true], ['2026-12-07T22:00:00Z', false],
  ]) assert.equal(isBoardBusinessHours(Date.parse(date)), expected, date)
})

test('repeat sessions require deliberate activation and the low-cost business window', () => {
  assert.equal(boardPolicy({}, monday).repeatSessions, false)
  assert.equal(boardPolicy(env, monday).repeatSessions, true)
  assert.equal(boardPolicy(env, Date.parse('2026-10-19T21:00:00Z')).repeatSessions, false)
})

test('the Board always uses the DeepSeek 1017 model with no premium fallback', () => {
  const saturday = Date.parse('2026-10-17T19:00:00Z')
  const preview = { ...env, VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'feat/live-service-demos', BOARD_PREVIEW_DEEPSEEK: 'true' }
  for (const overrides of [null, { VERCEL_ENV: 'production' }, { VERCEL_ENV: 'development' }, { VERCEL_GIT_COMMIT_REF: 'preview' }, { VERCEL_GIT_COMMIT_REF: undefined }, { BOARD_PREVIEW_DEEPSEEK: undefined }, { BOARD_PREVIEW_DEEPSEEK: 'false' }]) {
    const policy = boardPolicy({ ...preview, ...overrides }, saturday)
    assert.equal(policy.businessHours, false)
    assert.equal(policy.repeatSessions, false)
    assert.equal(policy.model, 'deepseek/deepseek-v4.1-flash-1017')
    const options = boardGenerationOptions(policy)
    assert.deepEqual(options.providerOptions.gateway, { caching: 'auto', only: ['deepseek'] })
    assert.equal(options.reasoning, 'none')
  }
  const record = boardUsageRecord({}, boardPolicy(preview, saturday), saturday)
  assert.equal(record.at, '2026-10-17T19:00:00.000Z')
  assert.equal(record.businessHours, false)
  assert.equal(record.requestedModel, 'deepseek/deepseek-v4.1-flash-1017')
})

test('availability lookup does not consume model tokens or require customer contact', async () => {
  const handler = createBoardHandler({ env, now: () => monday, streamText: () => { throw new Error('must not generate') } })
  const response = await handler(new Request('https://example.test/api/board'))
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { repeatSessions: true, hours: 'Monday–Friday, 8am–5pm Eastern', timezone: 'America/Indianapolis' })
})

test('a previously opened repeat form cannot trigger premium generation after closing', async () => {
  const handler = createBoardHandler({ env, now: () => Date.parse('2026-10-19T21:00:00Z'), streamText: () => { throw new Error('must not generate') } })
  const request = new Request('https://example.test/api/board', { method: 'POST', body: JSON.stringify({ question: 'Should I hire another technician?', repeatSession: true }) })
  assert.equal((await handler(request)).status, 403)
})

test('business hours use DeepSeek with reusable prefix, output cap, no premium fallback and measured usage', async () => {
  const calls = [], records = []
  const handler = createBoardHandler({ env, now: () => monday, onUsage: value => records.push(value), streamText: options => {
    calls.push(options)
    return { textStream: (async function* () {
      yield 'Complete decision brief.'
      await options.onFinish({ finishReason: 'stop', usage: { inputTokens: 1500, outputTokens: 900, inputTokenDetails: { cacheReadTokens: 1024 }, outputTokenDetails: { reasoningTokens: 0 } }, providerMetadata: { gateway: { cost: '0.000614472', generationId: 'fixture-generation' } } })
    })() }
  } })
  for (const question of ['Should I hire a second technician?', 'Should I change my opening hours?']) {
    const response = await handler(post(question))
    assert.equal(response.headers.get('x-board-primary-model'), 'deepseek/deepseek-v4.1-flash-1017')
    assert.equal(response.headers.get('x-board-fallback-models'), '')
    assert.equal(response.headers.get('x-board-repeat-sessions'), 'true')
    assert.equal(await response.text(), 'Complete decision brief.')
  }
  assert.equal(calls[0].instructions, calls[1].instructions)
  assert.notEqual(calls[0].prompt, calls[1].prompt)
  assert.deepEqual(calls[0].providerOptions, { gateway: { caching: 'auto', only: ['deepseek'] } })
  assert.equal(calls[0].reasoning, 'none')
  assert.equal(calls[0].maxOutputTokens, 3000)
  assert.equal(records.length, 2)
  assert.equal(records[0].costUsd, 0.000614472)
  assert.equal(records[0].withinPennyTarget, true)
  assert.equal(records[0].cacheReadTokens, 1024)
  assert.ok(!JSON.stringify(records).includes('technician'))
})

test('unknown and invalid cost remain unknown; costs above a penny are reported honestly', () => {
  const policy = boardPolicy(env, monday)
  for (const cost of [undefined, null, '', NaN, -1, 'unknown']) {
    const record = boardUsageRecord({ providerMetadata: { gateway: { cost } } }, policy, monday)
    assert.equal(record.costUsd, null)
    assert.equal(record.withinPennyTarget, null)
    assert.equal(record.costBasis, 'unavailable')
  }
  const record = boardUsageRecord({ providerMetadata: { gateway: { cost: 0.012 } } }, policy, monday)
  assert.equal(record.withinPennyTarget, false)
})

test('a length-truncated report is not counted as delivered', async () => {
  const handler = createBoardHandler({ env, now: () => monday, onUsage: () => {}, streamText: options => ({ textStream: (async function* () {
    yield 'Partial report'
    await options.onFinish({ finishReason: 'length' })
  })() }) })
  const response = await handler(post('Should we add a new service?'))
  await assert.rejects(response.text(), /length limit/)
})

test('pinned AI SDK delivers final charge metadata before closing and rejects truncation', async () => {
  for (const finishReason of ['stop', 'length']) {
    const records = []
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({
      chunks: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'report' },
        { type: 'text-delta', id: 'report', delta: 'A decision brief.' },
        { type: 'text-end', id: 'report' },
        { type: 'finish', finishReason: { unified: finishReason, raw: finishReason }, usage: { inputTokens: { total: 1000, noCache: 232, cacheRead: 768 }, outputTokens: { total: 900, text: 900, reasoning: 0 } }, providerMetadata: { gateway: { cost: '0.000577104', generationId: 'fixture-sdk-generation' } } },
      ], initialDelayInMs: null, chunkDelayInMs: null,
    }) }) })
    const handler = createBoardHandler({ env, now: () => monday, onUsage: record => records.push(record), streamText: options => streamText({ ...options, model }) })
    const response = await handler(post('Should we expand our service area?'))
    if (finishReason === 'length') await assert.rejects(response.text(), /length limit/)
    else assert.equal(await response.text(), 'A decision brief.')
    assert.equal(records[0].costUsd, 0.000577104)
    assert.equal(records[0].cacheReadTokens, 768)
    assert.equal(records[0].reasoningTokens, 0)
    assert.equal(records[0].finishReason, finishReason)
  }
})

test('returning visitors can ask again when server repeat policy is active', async () => {
  const source = readFileSync(new URL('../dist/board.js', import.meta.url), 'utf8')
  for (const repeatSessions of [true, false]) {
    const elements = new Map()
    const element = id => {
      if (!elements.has(id)) elements.set(id, { value: '', style: {}, disabled: false, hidden: id === 'boardDownload', textContent: '', classList: { add() {}, remove() {} }, setAttribute() {}, addEventListener() {} })
      return elements.get(id)
    }
    const context = vm.createContext({
      document: { getElementById: element }, window: { location: { search: '' } }, URLSearchParams, AbortSignal,
      localStorage: { getItem: () => JSON.stringify({ q: 'Previous decision' }) },
      fetch: async () => ({ ok: true, json: async () => ({ repeatSessions }) }),
    })
    vm.runInContext(source, context)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(element('boardInputBlock').style.display, repeatSessions ? undefined : 'none')
    assert.equal(element('boardSubmit').disabled, false)
    if (repeatSessions) assert.match(element('boardSessionNote').textContent, /four sessions per hour/)
    else {
      assert.match(element('boardCompleteMessage').textContent, /previous session is complete/)
      assert.doesNotMatch(element('boardCompleteMessage').textContent, /report is ready/)
    }
    assert.equal(element('boardDownload').hidden, true)
  }
})

test('download exists only for a completed report and contains the exact decision and plain text', async () => {
  const source = readFileSync(new URL('../dist/board.js', import.meta.url), 'utf8')
  const elements = new Map(), links = []
  let savedBlob, revoked
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', style: {}, disabled: false, hidden: id === 'boardDownload', textContent: '', classList: { add() {}, remove() {} }, setAttribute() {}, addEventListener() {} })
    return elements.get(id)
  }
  const context = vm.createContext({
    document: {
      getElementById: element,
      createElement: () => { const link = { click() { this.clicked = true }, remove() {} }; links.push(link); return link },
      body: { append() {} },
    },
    window: { location: { search: '' } }, URLSearchParams, AbortSignal, Blob,
    URL: { createObjectURL(blob) { savedBlob = blob; return 'blob:report-fixture' }, revokeObjectURL(url) { revoked = url } },
    setTimeout: fn => fn(), localStorage: { getItem: () => null },
    fetch: async () => ({ ok: true, json: async () => ({ repeatSessions: false }) }),
  })
  vm.runInContext(source, context)
  await new Promise(resolve => setImmediate(resolve))
  vm.runInContext('downloadBoardReport()', context)
  assert.equal(links.length, 0)
  context.decision = 'Should I add a second truck?'
  context.report = '# Recommendation\nWait until demand is proven.\nLiteral <script> stays text.'
  vm.runInContext('setCompletedBoardReport(decision, report); downloadBoardReport()', context)
  assert.equal(element('boardDownload').hidden, false)
  assert.equal(links[0].download, 'LegacyAI-Board-Report.txt')
  assert.equal(links[0].clicked, true)
  assert.equal(savedBlob.type, 'text/plain;charset=utf-8')
  assert.equal(await savedBlob.text(), `YOUR BOARD REPORT\n\nDecision: ${context.decision}\n\n${context.report}\n`)
  assert.equal(revoked, 'blob:report-fixture')
  vm.runInContext("setCompletedBoardReport('', ''); downloadBoardReport()", context)
  assert.equal(element('boardDownload').hidden, true)
  assert.equal(links.length, 1)
})
