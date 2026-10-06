import { SPEEDS, type Attempt, type Focus, type Mode, type TrapCategory } from './types'

/** Modes where the learner is actually hunting for mismatches. */
const HIW_MODES: ReadonlySet<Mode> = new Set(['practice', 'drill', 'recovery', 'overclick', 'exam', 'stress', 'review'])

export function isHiwAttempt(a: Attempt): boolean {
  return HIW_MODES.has(a.mode)
}

export interface GroupStats {
  n: number
  hits: number
  falsePositives: number
  misses: number
  selections: number
  mismatches: number
  /** Pooled: hits / selections. */
  precision: number | null
  /** Pooled: hits / mismatches. */
  recall: number | null
  avgNet: number
  /** Mean of per-attempt ±2 sync, over attempts that have tracking. */
  within2: number | null
  avgLag: number | null
  lossEventsPerAttempt: number
  avgRecoveryMs: number | null
  avgLatencyMs: number | null
  /** Share of hits clicked late or very late. */
  lateShare: number | null
  /** Share of misses that happened while drifting or lost. */
  missesDuringLossShare: number | null
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

export function groupStats(attempts: readonly Attempt[]): GroupStats {
  let hits = 0
  let fp = 0
  let misses = 0
  let sel = 0
  let mm = 0
  let late = 0
  let lossMisses = 0
  for (const a of attempts) {
    const s = a.summary.score
    hits += s.hits
    fp += s.falsePositives
    misses += s.misses
    sel += s.selections
    mm += s.mismatches
    late += a.summary.lateClicks
    lossMisses += a.summary.missesDuringLoss
  }
  const syncs = attempts.map((a) => a.summary.sync).filter((s) => s !== null)
  return {
    n: attempts.length,
    hits,
    falsePositives: fp,
    misses,
    selections: sel,
    mismatches: mm,
    precision: sel ? hits / sel : null,
    recall: mm ? hits / mm : null,
    avgNet: mean(attempts.map((a) => a.summary.score.net)) ?? 0,
    within2: mean(syncs.map((s) => s.within2)),
    avgLag: mean(syncs.map((s) => s.avgLag)),
    lossEventsPerAttempt: mean(syncs.map((s) => s.lossEvents)) ?? 0,
    avgRecoveryMs: mean(syncs.map((s) => s.avgRecoveryMs).filter((x): x is number => x !== null)),
    avgLatencyMs: mean(attempts.map((a) => a.summary.avgLatencyMs).filter((x): x is number => x !== null)),
    lateShare: hits ? late / hits : null,
    missesDuringLossShare: misses ? lossMisses / misses : null,
  }
}

export interface TrapStat {
  category: TrapCategory
  total: number
  misses: number
  missRate: number
}

export function trapStats(attempts: readonly Attempt[]): TrapStat[] {
  const totals = new Map<TrapCategory, { total: number; misses: number }>()
  for (const a of attempts) {
    for (const [c, n] of Object.entries(a.summary.trapTotals) as [TrapCategory, number][]) {
      const cur = totals.get(c) ?? { total: 0, misses: 0 }
      cur.total += n
      cur.misses += a.summary.trapMisses[c] ?? 0
      totals.set(c, cur)
    }
  }
  return [...totals.entries()]
    .map(([category, v]) => ({ category, ...v, missRate: v.total ? v.misses / v.total : 0 }))
    .sort((x, y) => y.missRate - x.missRate || y.total - x.total)
}

export function groupBy<K extends string | number>(attempts: readonly Attempt[], key: (a: Attempt) => K): Map<K, GroupStats> {
  const m = new Map<K, Attempt[]>()
  for (const a of attempts) {
    const k = key(a)
    m.set(k, [...(m.get(k) ?? []), a])
  }
  return new Map([...m.entries()].map(([k, v]) => [k, groupStats(v)]))
}

export const THRESHOLDS = {
  precision: 0.9,
  recall: 0.85,
  within2: 0.9,
  /** Below these a weakness is flagged. */
  weakPrecision: 0.85,
  weakRecall: 0.8,
  weakWithin2: 0.85,
  weakTrapMissRate: 0.34,
  lateShare: 0.3,
  readinessWindow: 10,
} as const

/**
 * Rank current weaknesses from recent attempts (most recent first).
 * Never escalates difficulty just because exercises were completed.
 */
export function weaknesses(recent: readonly Attempt[]): Focus[] {
  const hiw = recent.filter(isHiwAttempt).slice(0, 25)
  const all = recent.slice(0, 25)
  if (hiw.length < 3) return [{ type: 'baseline' }]
  const g = groupStats(hiw)
  const tracking = groupStats(all)
  const out: { f: Focus; severity: number }[] = []
  if (tracking.within2 !== null && tracking.within2 < THRESHOLDS.weakWithin2) {
    out.push({ f: { type: 'tracking' }, severity: THRESHOLDS.weakWithin2 - tracking.within2 + 0.1 })
  }
  if (g.precision !== null && g.precision < THRESHOLDS.weakPrecision && g.selections >= 4) {
    out.push({ f: { type: 'overclicking' }, severity: THRESHOLDS.weakPrecision - g.precision + 0.15 })
  }
  if (g.recall !== null && g.recall < THRESHOLDS.weakRecall && (g.precision ?? 1) >= THRESHOLDS.weakPrecision) {
    out.push({ f: { type: 'discrimination' }, severity: THRESHOLDS.weakRecall - g.recall })
  }
  if (g.lateShare !== null && g.lateShare > THRESHOLDS.lateShare && (tracking.within2 ?? 0) >= THRESHOLDS.weakWithin2) {
    out.push({ f: { type: 'latency' }, severity: g.lateShare - THRESHOLDS.lateShare })
  }
  for (const t of trapStats(hiw).slice(0, 2)) {
    if (t.total >= 2 && t.missRate >= THRESHOLDS.weakTrapMissRate) {
      out.push({ f: { type: 'trap', category: t.category }, severity: t.missRate * 0.5 })
    }
  }
  return out.sort((a, b) => b.severity - a.severity).map((x) => x.f)
}

export type SpeedAdvice =
  | { kind: 'not-enough-data'; speed: number; have: number; need: number }
  | { kind: 'ready-up'; speed: number; next: number; stats: GroupStats }
  | { kind: 'step-down'; speed: number; previous: number; stats: GroupStats; baseline: GroupStats }
  | { kind: 'hold'; speed: number; stats: GroupStats }

/** Stable-quality-first speed progression. `recent` is most-recent-first. */
export function speedAdvice(recent: readonly Attempt[], currentSpeed: number): SpeedAdvice {
  const W = THRESHOLDS.readinessWindow
  const hiw = recent.filter((a) => isHiwAttempt(a) && a.mode !== 'overclick')
  const at = (s: number) => hiw.filter((a) => Math.abs(a.speed - s) < 0.001)
  const idx = SPEEDS.findIndex((s) => Math.abs(s - currentSpeed) < 0.001)
  const cur = at(currentSpeed)

  if (idx > 0 && cur.length >= 3) {
    const previous = SPEEDS[idx - 1]
    const base = at(previous).slice(0, W)
    if (base.length >= 3) {
      const now = groupStats(cur.slice(0, 5))
      const b = groupStats(base)
      const drop = (x: number | null, y: number | null) => (x !== null && y !== null ? y - x : 0)
      if (drop(now.within2, b.within2) > 0.15 || drop(now.precision, b.precision) > 0.1 || drop(now.recall, b.recall) > 0.15) {
        return { kind: 'step-down', speed: currentSpeed, previous, stats: now, baseline: b }
      }
    }
  }

  if (cur.length < W) return { kind: 'not-enough-data', speed: currentSpeed, have: cur.length, need: W }
  const stats = groupStats(cur.slice(0, W))
  const ready =
    (stats.precision ?? 0) >= THRESHOLDS.precision &&
    (stats.recall ?? 0) >= THRESHOLDS.recall &&
    (stats.within2 ?? 0) >= THRESHOLDS.within2
  if (ready && idx >= 0 && idx < SPEEDS.length - 1) {
    return { kind: 'ready-up', speed: currentSpeed, next: SPEEDS[idx + 1], stats }
  }
  return { kind: 'hold', speed: currentSpeed, stats }
}

/**
 * Difficulty level for realistic passages: 1 easier (slower/shorter), 2 exam standard, 3 harder.
 * Drops to 1 while sync or precision is weak; rises to 3 only after 20 stable passages at level ≥ 2.
 */
export function targetLevel(recent: readonly Attempt[]): 1 | 2 | 3 {
  const hiw = recent.filter((a) => isHiwAttempt(a) && a.mode !== 'overclick')
  const last10 = groupStats(hiw.slice(0, 10))
  const synced = groupStats(recent.slice(0, 10)).within2
  if (hiw.length >= 4 && ((synced !== null && synced < 0.75) || (last10.precision !== null && last10.precision < 0.7))) return 1
  const atStandard = hiw.filter((a) => (a.summary.difficulty ?? 2) >= 2).slice(0, 20)
  if (atStandard.length >= 20) {
    const g = groupStats(atStandard)
    if ((g.precision ?? 0) >= THRESHOLDS.precision && (g.recall ?? 0) >= THRESHOLDS.recall && (g.within2 ?? 0) >= THRESHOLDS.within2) return 3
  }
  return 2
}
