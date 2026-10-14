export type Phase = 'idle' | 'working' | 'done'

export type Meter = {
  phase: Phase
  // This turn: shown live while working, kept after it ends until the next one starts.
  turnOutTokens: number
  turnCostUsd: number
  turnElapsedMs: number
  isTurnEstimate: boolean
  // This session (resets with /clear).
  sessionOutTokens: number
  sessionCostUsd: number
  frame: number
}

export type Rate = { krwPerUsd: number; isLive: boolean }

declare module 'claude-code' {
  interface PluginState {
    'token-meter': { meter: Meter; rate: Rate }
  }
}
