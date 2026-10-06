import type { Interaction, Token } from './types'

export type LatencyBucket = 'early' | 'fast' | 'normal' | 'late' | 'very-late'

export const LATENCY_MS = { fast: 600, normal: 1500, late: 3000 } as const

/**
 * Wall-clock latency from the end of the spoken word to the click that left it selected.
 * Negative means the click happened before the word finished.
 */
export function clickLatencyMs(token: Token, interactions: readonly Interaction[], rate = 1): number | null {
  let lastSelect: Interaction | null = null
  for (const i of interactions) {
    if (i.tokenIndex !== token.index) continue
    lastSelect = i.action === 'select' ? i : null
  }
  if (!lastSelect) return null
  return (lastSelect.t - token.endMs) / rate
}

export function latencyBucket(ms: number): LatencyBucket {
  if (ms < -150) return 'early'
  if (ms <= LATENCY_MS.fast) return 'fast'
  if (ms <= LATENCY_MS.normal) return 'normal'
  if (ms <= LATENCY_MS.late) return 'late'
  return 'very-late'
}
