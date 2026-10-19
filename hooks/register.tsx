import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, Timer } from 'claude-code'

import type { Meter, Rate } from '../types'
import { formatElapsed, formatKrw, formatTokens, formatUsd } from './format'
import { costOf, estimateTokens, outputCostOf } from './pricing'

const EMPTY: Meter = {
  phase: 'idle',
  turnInTokens: 0,
  turnOutTokens: 0,
  turnCostUsd: 0,
  turnElapsedMs: 0,
  isTurnEstimate: false,
  sessionInTokens: 0,
  sessionOutTokens: 0,
  sessionCostUsd: 0,
  frame: 0,
}

const DEFAULT_RATE: Rate = { krwPerUsd: 1400, isLive: false }

const meter = atom({ plugin: 'token-meter', key: 'meter' } as const, EMPTY)
const rate = atom({ plugin: 'token-meter', key: 'rate' } as const, DEFAULT_RATE)

const TICK_MS = 250
const RATE_MAX_AGE_MS = 12 * 60 * 60 * 1000
const RATE_URL = 'https://open.er-api.com/v6/latest/USD'
const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']

type Palette = { success: string; subtle: string; faint: string; turn: string; accent: string }

// Colors by theme, the same on the terminal and in the desktop app, so the band looks alike in both.
// `dimColor` turns a run grey on the terminal, so the ₩ figure takes `faint`, the theme's green at 55%
// over its background. Under dark-ansi the terminal's palette repaints every key, and the desktop
// resolves the keys to its own colors; fixed values keep the dark theme's green and grey, Claude's
// orange for this turn's count (`turn`) and a red for the session's (`accent`) in both. Other themes
// (daltonized, light-ansi, custom) keep the theme keys, `dimColor` and the `claude` accent, which each
// surface draws its own way.
const DARK: Palette = { success: '#4EBA65', subtle: '#505050', faint: '#357142', turn: '#D77757', accent: '#DD4E56' }
const PALETTES: Readonly<Record<string, Palette>> = {
  dark: DARK,
  'dark-ansi': DARK,
  light: { success: 'success', subtle: 'subtle', faint: '#8BB692', turn: '#D77757', accent: '#C4313A' },
}

type Turn = {
  startedAt: number
  // The session ledger when the turn began; undefined where Claude Code keeps none.
  ledgerAtStart: number | undefined
  confirmedIn: number
  confirmedOut: number
  confirmedUsd: number
  // Streamed output of requests cut short (escape), which the API never reported.
  estimatedOut: number
  estimatedUsd: number
  shownOut: number
}

type Streaming = { tokens: number; model: string }

// Module state: lost on a reload, which session.start picks back up from $.state.
const live = {
  turn: null as Turn | null,
  ticker: null as Timer | null,
  // Confirmed session figures; the meter's session fields add what is still streaming.
  sessionIn: 0,
  sessionOut: 0,
  sessionUsd: 0,
  sessionEstimatedOut: 0,
  sessionEstimatedUsd: 0,
  fixedRate: 0,
  theme: '',
  streaming: new Map<string, Streaming>(),
}

// Every token the request read: uncached, served by the prompt cache, or written to it.
function inputOf(usage: ModelUsage): number {
  return usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
}

async function ledger($: EngineInterface): Promise<number | undefined> {
  try {
    return (await $.session.usage()).cost?.usd
  } catch {
    return undefined
  }
}

function streamingTotals(): { tokens: number; usd: number } {
  let tokens = 0
  let usd = 0

  for (const step of live.streaming.values()) {
    tokens += step.tokens
    usd += outputCostOf(step.tokens, step.model)
  }

  return { tokens, usd }
}

async function tick($: EngineInterface) {
  const turn = live.turn

  if (turn === null) {
    return
  }

  const now = await $.clock.now()
  const flowing = streamingTotals()
  const kept = turn.confirmedOut + turn.estimatedOut
  const gap = kept + flowing.tokens - turn.shownOut

  // Count up toward the target so the number climbs instead of jumping.
  if (gap > 0) {
    turn.shownOut += Math.max(Math.ceil(gap * 0.35), Math.min(gap, 3))
  }

  const shownExtra = Math.max(0, turn.shownOut - kept)

  await update($, meter, (m): Meter => ({
    ...m,
    phase: 'working',
    turnInTokens: turn.confirmedIn,
    turnOutTokens: turn.shownOut,
    turnCostUsd: turn.confirmedUsd + turn.estimatedUsd + flowing.usd,
    turnElapsedMs: now - turn.startedAt,
    isTurnEstimate: live.streaming.size > 0 || turn.estimatedOut > 0,
    sessionInTokens: live.sessionIn,
    sessionOutTokens: live.sessionOut + live.sessionEstimatedOut + shownExtra,
    sessionCostUsd: live.sessionUsd + live.sessionEstimatedUsd + flowing.usd,
    frame: m.frame + 1,
  }))
}

async function settleStep($: EngineInterface, usage: ModelUsage, model: string) {
  const stepUsd = costOf(usage, model)
  const total = await ledger($)
  const turn = live.turn

  live.sessionIn += inputOf(usage)
  live.sessionOut += usage.output_tokens
  live.sessionUsd = total ?? live.sessionUsd + stepUsd

  if (turn !== null) {
    turn.confirmedIn += inputOf(usage)
    turn.confirmedOut += usage.output_tokens
    turn.confirmedUsd = turn.ledgerAtStart !== undefined && total !== undefined
      ? Math.max(0, total - turn.ledgerAtStart)
      : turn.confirmedUsd + stepUsd

    return
  }

  // A step outside a main turn (a background agent) still counts toward the session.
  await showSession($)
}

async function showSession($: EngineInterface) {
  await update($, meter, (m): Meter => ({
    ...m,
    sessionInTokens: live.sessionIn,
    sessionOutTokens: live.sessionOut + live.sessionEstimatedOut,
    sessionCostUsd: live.sessionUsd + live.sessionEstimatedUsd,
  }))
}

// A request cut short ends without a stop or usage: keep what streamed as an estimate rather than drop it.
function keepEstimate(step: Streaming) {
  const usd = outputCostOf(step.tokens, step.model)

  live.sessionEstimatedOut += step.tokens
  live.sessionEstimatedUsd += usd

  if (live.turn !== null) {
    live.turn.estimatedOut += step.tokens
    live.turn.estimatedUsd += usd
  }
}

async function fetchRate($: EngineInterface, now: number) {
  try {
    const response = await $.http.fetch(RATE_URL)
    const krw = response.ok ? Number(JSON.parse(response.text)?.rates?.KRW) : NaN

    if (Number.isFinite(krw) && krw > 0) {
      await $.store.set('rate', { krwPerUsd: krw, fetchedAt: now })
      await update($, rate, (): Rate => ({ krwPerUsd: krw, isLive: true }))
    }
  } catch {
    // Offline or refused: keep the cached or default rate.
  }
}

async function loadRate($: EngineInterface) {
  if (live.fixedRate > 0) {
    await update($, rate, (): Rate => ({ krwPerUsd: live.fixedRate, isLive: false }))

    return
  }

  const cached = (await $.store.get('rate')) as { krwPerUsd?: number; fetchedAt?: number } | undefined
  const now = await $.clock.now()

  if (cached?.krwPerUsd !== undefined && cached.krwPerUsd > 0) {
    const krw = cached.krwPerUsd
    await update($, rate, (): Rate => ({ krwPerUsd: krw, isLive: true }))
  }

  if (cached?.fetchedAt === undefined || now - cached.fetchedAt >= RATE_MAX_AGE_MS) {
    // Not awaited: session.start is awaited before the first prompt.
    void fetchRate($, now)
  }
}

async function readTheme($: EngineInterface) {
  try {
    const row = (await $.config.list()).find((r) => r.key === 'theme')
    live.theme = typeof row?.value === 'string' ? row.value : ''
  } catch {
    live.theme = ''
  }
}

function resetSession() {
  live.ticker?.cancel()
  live.ticker = null
  live.turn = null
  live.sessionIn = 0
  live.sessionOut = 0
  live.sessionUsd = 0
  live.sessionEstimatedOut = 0
  live.sessionEstimatedUsd = 0
  live.streaming.clear()
}

export const register: Register = (on, options) => {
  live.fixedRate = typeof options.krwPerUsd === 'number' && options.krwPerUsd > 0 ? options.krwPerUsd : 0

  on('session.start', async ($, e, next) => {
    // After a reload, pick the session figures back up from $.state.
    const kept = await read($, meter)
    // A meter kept from before input was counted has no input fields.
    live.sessionIn = kept.sessionInTokens ?? 0
    live.sessionOut = kept.sessionOutTokens
    live.sessionUsd = kept.sessionCostUsd
    await loadRate($)
    await readTheme($)

    return next(e)
  })

  // Follow a theme change made mid-session; the .catch lets the change through whatever happens here.
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    await readTheme($)

    return result
  }).catch((_$, e, next) => next(e))

  // /clear, /resume and /branch reset $.state without a new session.start.
  // The .catch passes on to Claude Code: a failure here must not hold up /clear.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    resetSession()
    await loadRate($)

    return next(e)
  }).catch((_$, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }

    live.ticker?.cancel()
    live.streaming.clear()
    live.turn = {
      startedAt: await $.clock.now(),
      ledgerAtStart: await ledger($),
      confirmedIn: 0,
      confirmedOut: 0,
      confirmedUsd: 0,
      estimatedOut: 0,
      estimatedUsd: 0,
      shownOut: 0,
    }
    await update($, meter, (m): Meter => ({
      ...m,
      phase: 'working',
      turnInTokens: 0,
      turnOutTokens: 0,
      turnCostUsd: 0,
      turnElapsedMs: 0,
      isTurnEstimate: false,
    }))
    live.ticker = $.clock.every(TICK_MS, () => {
      void tick($)
    })

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const id = `${e.turnId}:${e.agentId ?? 'main'}:${e.index}`
    const step: Streaming = { tokens: 0, model: e.model }
    live.streaming.set(id, step)

    try {
      for await (const chunk of next(e)) {
        yield chunk

        if (chunk.kind === 'text' || chunk.kind === 'thinking') {
          step.tokens += estimateTokens(chunk.text)
        } else if (chunk.kind === 'input') {
          step.tokens += estimateTokens(chunk.json)
        } else if (chunk.kind === 'stop') {
          live.streaming.delete(id)

          if (chunk.usage !== null) {
            await settleStep($, chunk.usage, chunk.usage.model || e.model)
          }
        }
      }
    } finally {
      // Still listed: the stream ended before its stop, unless turn.complete already kept it.
      if (live.streaming.get(id) === step) {
        live.streaming.delete(id)
        keepEstimate(step)

        if (live.turn === null) {
          await showSession($)
        }
      }
    }
  })

  on('turn.complete', async ($, e, next) => {
    const done = live.turn

    if (e.agentId !== undefined) {
      return next(e)
    }

    if (done === null) {
      // The module was replaced mid-turn: close the turn with what $.state already shows.
      await update($, meter, (m): Meter => ({ ...m, phase: 'done', turnElapsedMs: e.durationMs, isTurnEstimate: false }))

      return next(e)
    }

    // A request still streaming was cut off with the turn.
    for (const step of live.streaming.values()) {
      keepEstimate(step)
    }

    live.streaming.clear()
    live.ticker?.cancel()
    live.ticker = null
    live.turn = null

    await update($, meter, (m): Meter => ({
      ...m,
      phase: 'done',
      turnInTokens: done.confirmedIn,
      turnOutTokens: done.confirmedOut + done.estimatedOut,
      turnCostUsd: done.confirmedUsd + done.estimatedUsd,
      turnElapsedMs: e.durationMs,
      isTurnEstimate: done.estimatedOut > 0,
      sessionInTokens: live.sessionIn,
      sessionOutTokens: live.sessionOut + live.sessionEstimatedOut,
      sessionCostUsd: live.sessionUsd + live.sessionEstimatedUsd,
    }))

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    resetSession()

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const m = await read($, meter)
    const { krwPerUsd } = await read($, rate)
    const { Box, Text } = $.ui.resolve(e)

    const isWorking = m.phase === 'working'
    const palette = PALETTES[live.theme]
    const success = palette?.success ?? 'success'
    const subtle = palette?.subtle ?? 'subtle'
    const turnColor = palette?.turn ?? 'claude'
    const accent = palette?.accent ?? 'claude'
    // The ₩ figure: a faint green where the palette has one, else the theme's own dimming.
    const faint = palette === undefined ? { color: 'success', dimColor: true } : { color: palette.faint }
    const isNarrow = e.props.bodyColumns < 78
    const glyph = isWorking ? FRAMES[m.frame % FRAMES.length] ?? '✻' : m.phase === 'done' ? '✓' : '○'
    const glyphColor = isWorking ? turnColor : m.phase === 'done' ? success : subtle
    const approx = m.isTurnEstimate ? '≈' : ''
    // While working the count is always partly streamed; once done, ≈ marks a request cut short.
    const approxTokens = m.isTurnEstimate && m.phase === 'done' ? '≈' : ''

    // `bold` rather than `weight`/`tabular`: the Claude Code inside the desktop app (2.1.295) draws nothing with those.
    return (
      <Box flexDirection={isNarrow ? 'column' : 'row'} columnGap={1}>
        <Box key="turn" flexDirection="row" columnGap={1}>
          <Text color={glyphColor} bold>{glyph}</Text>
          <Text color={subtle}>{isWorking ? '작업 중' : '이번 턴'}</Text>
          <Text color={turnColor} bold>↓ {approxTokens}{formatTokens((m.turnInTokens ?? 0) + m.turnOutTokens)} tokens</Text>
          <Text color={subtle}>{formatElapsed(m.turnElapsedMs)}</Text>
          <Text color={success}>{approx}{formatUsd(m.turnCostUsd)}</Text>
          <Text {...faint}>{formatKrw(m.turnCostUsd, krwPerUsd)}</Text>
        </Box>
        <Box key="session" flexDirection="row" columnGap={1}>
          <Text color={subtle}>{isNarrow ? ' ' : '│'}</Text>
          <Text color={subtle}>세션 누적</Text>
          <Text color={accent} bold>↓ {formatTokens((m.sessionInTokens ?? 0) + m.sessionOutTokens)} tokens</Text>
          <Text color={success}>{formatUsd(m.sessionCostUsd)}</Text>
          <Text {...faint}>{formatKrw(m.sessionCostUsd, krwPerUsd)}</Text>
        </Box>
      </Box>
    )
  })
}
