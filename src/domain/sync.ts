import type { SyncMetrics, TrackingSample } from './types'

export type SyncState = 'synced' | 'drift' | 'lost' | 'untracked'

export const SYNC = {
  excellent: 1,
  acceptable: 2,
  /** |lag| at or above this starts a synchronization-loss event. */
  loss: 5,
} as const

export function lagOf(s: TrackingSample): number | null {
  if (s.pointer === null || s.spoken < 0) return null
  return s.pointer - s.spoken
}

export function stateOfLag(lag: number | null): SyncState {
  if (lag === null) return 'untracked'
  const a = Math.abs(lag)
  if (a <= SYNC.acceptable) return 'synced'
  if (a < SYNC.loss) return 'drift'
  return 'lost'
}

export interface LossEvent {
  startT: number
  /** Media time when back within ±2, or null if never recovered. */
  endT: number | null
  /** Most extreme lag during the event (negative = behind). */
  worstLag: number
  /** Wall-clock recovery duration in ms (to end of passage if never recovered). */
  recoveryMs: number
}

/**
 * Loss events: start when |lag| >= 5, end when back within ±2.
 * Durations are converted to wall-clock using the playback rate.
 */
export function lossEvents(samples: readonly TrackingSample[], rate = 1): LossEvent[] {
  const events: LossEvent[] = []
  let cur: { startT: number; worstLag: number } | null = null
  let lastT = 0
  for (const s of samples) {
    const lag = lagOf(s)
    if (lag === null) continue
    lastT = s.t
    if (cur) {
      if (Math.abs(lag) > Math.abs(cur.worstLag)) cur.worstLag = lag
      if (Math.abs(lag) <= SYNC.acceptable) {
        events.push({ ...cur, endT: s.t, recoveryMs: (s.t - cur.startT) / rate })
        cur = null
      }
    } else if (Math.abs(lag) >= SYNC.loss) {
      cur = { startT: s.t, worstLag: lag }
    }
  }
  if (cur) events.push({ ...cur, endT: null, recoveryMs: (lastT - cur.startT) / rate })
  return events
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function syncMetrics(samples: readonly TrackingSample[], rate = 1): SyncMetrics | null {
  const active = samples.filter((s) => s.spoken >= 0)
  const lags = active.map(lagOf).filter((l): l is number => l !== null)
  if (lags.length === 0) return null
  const n = lags.length
  const frac = (pred: (l: number) => boolean) => lags.filter(pred).length / n
  const events = lossEvents(samples, rate)
  const recovered = events.filter((e) => e.endT !== null).map((e) => e.recoveryMs)
  return {
    coverage: n / Math.max(1, active.length),
    within1: frac((l) => Math.abs(l) <= SYNC.excellent),
    within2: frac((l) => Math.abs(l) <= SYNC.acceptable),
    behind3: frac((l) => l <= -3),
    ahead3: frac((l) => l >= 3),
    avgLag: lags.reduce((a, b) => a + b, 0) / n,
    medianLag: median(lags),
    maxBehind: Math.min(0, ...lags),
    lossEvents: events.length,
    avgRecoveryMs: recovered.length ? recovered.reduce((a, b) => a + b, 0) / recovered.length : null,
    longestRecoveryMs: events.length ? Math.max(...events.map((e) => e.recoveryMs)) : null,
  }
}

export interface SyncSegment {
  startT: number
  endT: number
  state: SyncState
  /** Most extreme lag in the segment. */
  worstLag: number
}

/** Collapse samples into contiguous segments for the timeline. */
export function syncSegments(samples: readonly TrackingSample[], endT?: number): SyncSegment[] {
  const segs: SyncSegment[] = []
  const active = samples.filter((s) => s.spoken >= 0)
  for (let i = 0; i < active.length; i++) {
    const s = active[i]
    const lag = lagOf(s)
    const state = stateOfLag(lag)
    const last = segs[segs.length - 1]
    if (last && last.state === state) {
      last.endT = s.t
      if (lag !== null && Math.abs(lag) > Math.abs(last.worstLag)) last.worstLag = lag
    } else {
      if (last) last.endT = s.t
      segs.push({ startT: s.t, endT: s.t, state, worstLag: lag ?? 0 })
    }
  }
  const last = segs[segs.length - 1]
  if (last && endT !== undefined && endT > last.endT) last.endT = endT
  return segs
}

/** The sample closest in time to `t`. */
export function sampleAt(samples: readonly TrackingSample[], t: number): TrackingSample | null {
  let best: TrackingSample | null = null
  let bestD = Infinity
  for (const s of samples) {
    const d = Math.abs(s.t - t)
    if (d < bestD) {
      best = s
      bestD = d
    }
  }
  return bestD <= 1000 ? best : null
}

/** Pointer lag at media time `t`, or null when no tracking data is near that time. */
export function lagAt(samples: readonly TrackingSample[], t: number): number | null {
  const s = sampleAt(samples, t)
  return s ? lagOf(s) : null
}

/** Recovery time (wall ms) after each blackout: from blackout end until back within ±2. */
export function blackoutRecoveries(samples: readonly TrackingSample[], blackouts: readonly [number, number][], rate = 1): (number | null)[] {
  return blackouts.map(([, end]) => {
    for (const s of samples) {
      if (s.t < end) continue
      const lag = lagOf(s)
      if (lag !== null && Math.abs(lag) <= SYNC.acceptable) return (s.t - end) / rate
    }
    return null
  })
}
