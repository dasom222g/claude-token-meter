import type { ModelUsage } from 'claude-code'

// USD per million tokens, Anthropic first-party API list prices (2026-10).
// Used only where Claude Code's own cost ledger ($.session.usage().cost) is absent,
// and to price output that is still streaming. Cache writes use the 5-minute rate (1.25x input).
type Rate = { input: number; output: number; cacheRead: number }

const RATES: ReadonlyArray<[RegExp, Rate]> = [
  [/(fable|mythos)-5-1/, { input: 10, output: 50, cacheRead: 0.25 }],
  [/(fable|mythos)-5/, { input: 10, output: 50, cacheRead: 1 }],
  [/opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/opus-(5|4-[5-8])/, { input: 5, output: 25, cacheRead: 0.5 }],
  [/opus-4/, { input: 15, output: 75, cacheRead: 1.5 }],
  [/sonnet-5/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/sonnet-[34]/, { input: 3, output: 15, cacheRead: 0.3 }],
  [/haiku-5-5/, { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  [/haiku-4-5/, { input: 1, output: 5, cacheRead: 0.1 }],
  [/haiku-3-5/, { input: 0.8, output: 4, cacheRead: 0.08 }],
]

const FALLBACK: Rate = { input: 4, output: 20, cacheRead: 0.2 }
const HAIKU_LONG_PROMPT: Rate = { input: 0.5, output: 2.5, cacheRead: 0.05 }

function rateOf(model: string): Rate {
  const id = model.toLowerCase()

  return RATES.find(([pattern]) => pattern.test(id))?.[1] ?? FALLBACK
}

export function costOf(usage: ModelUsage, model: string): number {
  const prompt = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  const isLongHaiku = /haiku-5-5/.test(model.toLowerCase()) && prompt > 100_000
  const rate = isLongHaiku ? HAIKU_LONG_PROMPT : rateOf(model)

  return (
    usage.input_tokens * rate.input +
    usage.cache_creation_input_tokens * rate.input * 1.25 +
    usage.cache_read_input_tokens * rate.cacheRead +
    usage.output_tokens * rate.output
  ) / 1_000_000
}

export function outputCostOf(tokens: number, model: string): number {
  return (tokens * rateOf(model).output) / 1_000_000
}

// Rough token count of streamed text: about 4 Latin characters per token, about 1 token per Hangul or CJK character.
export function estimateTokens(text: string): number {
  let tokens = 0

  for (let i = 0; i < text.length; i += 1) {
    tokens += text.charCodeAt(i) < 0x80 ? 0.25 : 0.9
  }

  return tokens
}
