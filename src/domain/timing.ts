import type { Token } from './types'

/**
 * Index of the token being spoken at media time `t` (ms): the last token whose
 * start is <= t. Returns -1 before the first word.
 */
export function spokenIndexAt(tokens: readonly Token[], t: number): number {
  let lo = 0
  let hi = tokens.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (tokens[mid].startMs <= t) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/** Media-time ms → wall-clock ms at a given playback rate. */
export function toWallMs(mediaMs: number, rate: number): number {
  return mediaMs / rate
}

/**
 * Estimate word timings across a known duration, weighting by word length.
 * Used for uploaded audio without timestamps and for browser TTS.
 */
export function estimateTimings(words: string[], durationMs: number, leadInMs = 0): { startMs: number; endMs: number }[] {
  const weights = words.map((w) => 1 + w.replace(/[^\p{L}\p{N}]/gu, '').length * 0.35)
  const total = weights.reduce((a, b) => a + b, 0) || 1
  const usable = Math.max(0, durationMs - leadInMs)
  let t = leadInMs
  return weights.map((w) => {
    const startMs = Math.round(t)
    t += (w / total) * usable
    return { startMs, endMs: Math.round(t) }
  })
}
