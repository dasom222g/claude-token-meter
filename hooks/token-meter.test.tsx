import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const

const BAND = {
  plugin: 'token-meter',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const USAGE = {
  input_tokens: 1000,
  output_tokens: 600,
  cache_read_input_tokens: 20_000,
  cache_creation_input_tokens: 0,
  model: 'claude-opus-5-5',
}

// What the engine would stream for one model request: some text, then the stop with its usage.
function streamOneStep(on: On) {
  on('turn.step', async function* (_$, e) {
    yield { kind: 'text', index: 0, text: 'Hello there, this is a streamed answer. 안녕하세요.' }
    yield { kind: 'stop', stopReason: 'end_turn', usage: USAGE }

    return { turnId: e.turnId, index: e.index, answer: 'Hello', toolUses: [], stopReason: 'end_turn', usage: USAGE }
  })
}

function answerLedger(on: On, usd: () => number) {
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [], cost: { usd: usd() } },
  }))
}

// What the engine answers beneath the plugins for the turn and session events.
function answerEngine(on: On) {
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
}

test('the band shows zeros before any turn, on every surface', async ($, on) => {
  mock.clock(on)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect((await ui.find({ text: /이번 턴/ }))).toBeDefined()
    expect((await ui.find({ text: /세션 누적/ }))).toBeDefined()
    expect((await ui.find({ text: '↓ 0 tokens' }))).toBeDefined()
    expect((await ui.find({ text: '₩0' }))).toBeDefined()
    await ui.unmount()
  }
})

test('a turn counts up while working and keeps its figures once done', async ($, on) => {
  const clock = mock.clock(on)
  let ledger = 0.5
  answerLedger(on, () => ledger)
  answerEngine(on)
  streamOneStep(on)

  await $.turn.start({ text: 'hi', turnId: 't1' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ text: /작업 중/ }))).toBeDefined()
    await ui.unmount()
  }

  // The request finishes: Claude Code's ledger has grown by this request's cost.
  ledger = 0.5 + 0.0204
  for await (const _chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    // Drain the stream as the engine does.
  }

  // The request's input (1,000 + 20,000 + 0) counts at once; one tick in, the output has started
  // climbing from it but not jumped to the total.
  await clock.advance(250)
  const early = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const shown = Number((await early.find({ type: 'Box', key: 'turn' }))?.text.match(/↓ ([\d.]+)k tokens/)?.[1])
  expect(shown >= 21 && shown < 21.6).toBe(true)
  await early.unmount()

  // Let the counter climb to the confirmed 21,600 tokens: 21,000 in and 600 out.
  await clock.advance(5000)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ text: '↓ 21.6k tokens' }))).toBeDefined()
    await ui.unmount()
  }

  await $.turn.complete({ answer: 'Hello', durationMs: 12_000, isAborted: false, turnId: 't1', reason: 'answer' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ text: /이번 턴/ }))).toBeDefined()
    expect((await ui.find({ text: '12s' }))).toBeDefined()
    // This turn's cost is the ledger's growth over the turn; ₩ at the default rate of 1400.
    expect((await ui.find({ text: '$0.020' }))).toBeDefined()
    expect((await ui.find({ text: '₩29' }))).toBeDefined()
    // The session total is the whole ledger.
    expect((await ui.find({ text: '$0.520' }))).toBeDefined()
    // Tokens are input plus output; input adds the uncached, cache-read and cache-write tokens: 1,000 + 20,000 + 0.
    expect((await ui.find({ type: 'Box', key: 'turn' }))?.text).toMatch(/↓ 21\.6k tokens/)
    expect((await ui.find({ type: 'Box', key: 'session' }))?.text).toMatch(/↓ 21\.6k tokens/)
    await ui.unmount()
  }
})

test('a fixed rate from settings converts the cost to won', { options: { krwPerUsd: 1000 } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  let ledger = 0
  answerLedger(on, () => ledger)
  answerEngine(on)
  streamOneStep(on)

  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't2' })
  ledger = 0.5
  for await (const _chunk of $.turn.step({ turnId: 't2', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    // Drain the stream as the engine does.
  }
  await clock.advance(1000)
  await $.turn.complete({ answer: 'Hello', durationMs: 3000, isAborted: false, turnId: 't2', reason: 'answer' })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ text: '$0.500' }))).toBeDefined()
  expect((await ui.find({ text: '₩500' }))).toBeDefined()
  await ui.unmount()
})

test('a turn cut short keeps its streamed output as an estimate', async ($, on) => {
  const clock = mock.clock(on)
  answerLedger(on, () => 0)
  answerEngine(on)
  // Escape mid-answer: the stream ends with no stop and no usage.
  on('turn.step', async function* (_$, e) {
    yield { kind: 'text', index: 0, text: 'This answer was interrupted before it could finish.' }

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
  })

  await $.turn.start({ text: 'hi', turnId: 't3' })
  for await (const _chunk of $.turn.step({ turnId: 't3', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    // Drain the stream as the engine does.
  }
  await clock.advance(1000)
  await $.turn.complete({ answer: '', durationMs: 5000, isAborted: true, turnId: 't3', reason: 'aborted' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const turn = (await ui.find({ type: 'Box', key: 'turn' }))?.text ?? ''
    expect(turn).toMatch(/이번 턴/)
    expect(Number(turn.match(/↓ ≈(\d+) tokens/)?.[1]) > 0).toBe(true)
    expect(turn).toMatch(/≈\$0\.\d+/)
    expect((await ui.find({ type: 'Box', key: 'session' }))?.text).toMatch(/↓ [1-9]\d* tokens/)
    await ui.unmount()
  }
})

test('under dark-ansi the terminal keeps the dark theme greens and grey, the desktop the theme keys', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  answerEngine(on)
  on('config.list', () => ({
    value: [{ key: 'theme', label: 'Theme', kind: 'enum', value: 'dark-ansi', provider: { plugin: 'engine', tier: 'core' } }],
  }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await terminal.find({ type: 'Text', text: '세션 누적' }))?.props.color).toBe('#505050')
  expect((await terminal.find({ type: 'Text', text: '$0' }))?.props.color).toBe('#4EBA65')
  // The ₩ figure: a faint green, not the grey that dimColor gives on the terminal.
  expect((await terminal.find({ type: 'Text', text: '₩0' }))?.props.color).toBe('#357142')
  expect((await terminal.find({ type: 'Text', text: '₩0' }))?.props.dimColor).toBeUndefined()
  await terminal.unmount()

  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await desktop.find({ type: 'Text', text: '세션 누적' }))?.props.color).toBe('subtle')
  expect((await desktop.find({ type: 'Text', text: '₩0' }))?.props.dimColor).toBe(true)
  await desktop.unmount()
})

test("both token counts take the theme's accent on every surface", async ($, on) => {
  mock.clock(on)
  mock.store(on)
  answerEngine(on)
  on('config.list', () => ({
    value: [{ key: 'theme', label: 'Theme', kind: 'enum', value: 'dark-ansi', provider: { plugin: 'engine', tier: 'core' } }],
  }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const counts = await ui.findAll({ type: 'Text', text: '↓ 0 tokens' })
    expect(counts.length).toBe(2)
    for (const count of counts) {
      expect(count.props.color).toBe('claude')
    }
    await ui.unmount()
  }
})
