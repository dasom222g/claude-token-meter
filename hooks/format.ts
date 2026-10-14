// Formatting without Intl, which the hooks environment may not carry.

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function formatTokens(n: number): string {
  const whole = Math.max(0, Math.round(n))

  if (whole >= 1_000_000) {
    return `${(whole / 1_000_000).toFixed(2)}M`
  }

  if (whole >= 100_000) {
    return `${Math.round(whole / 1000)}k`
  }

  if (whole >= 10_000) {
    return `${(whole / 1000).toFixed(1)}k`
  }

  return groupThousands(String(whole))
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))

  if (seconds < 60) {
    return `${seconds}s`
  }

  const minutes = Math.floor(seconds / 60)

  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`
  }

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function formatUsd(usd: number): string {
  if (usd <= 0) {
    return '$0'
  }

  if (usd < 0.01) {
    return `$${usd.toFixed(4)}`
  }

  if (usd < 1) {
    return `$${usd.toFixed(3)}`
  }

  const [whole = '0', cents = '00'] = usd.toFixed(2).split('.')

  return `$${groupThousands(whole)}.${cents}`
}

export function formatKrw(usd: number, krwPerUsd: number): string {
  const krw = usd * krwPerUsd

  if (krw <= 0) {
    return '₩0'
  }

  if (krw < 10) {
    return `₩${krw.toFixed(1)}`
  }

  return `₩${groupThousands(String(Math.round(krw)))}`
}
