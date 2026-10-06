import { groupStats, isHiwAttempt, weaknesses, type GroupStats } from './adaptive'
import { mismatchRows } from './analysis'
import type { Coaching } from './coaching'
import type { Attempt, Exercise, Focus, TrapCategory } from './types'

const pct = (x: number) => Math.round(x * 100)

// ── Over-clicking diagnostic ─────────────────────────────────────────────

export type ClickProfile = 'threshold' | 'tracking' | 'discrimination' | 'balanced'

export interface OverclickReport {
  passages: number
  zeroPassages: number
  /** False clicks on passages that had no mismatch at all. */
  clicksOnZero: number
  falseClicks: number
  hits: number
  mismatches: number
  /** Points lost to false clicks (each −1). */
  pointsLost: number
  net: number
  precision: number | null
  recall: number | null
  missesDuringLossShare: number | null
  profile: ClickProfile
}

export function overclickReport(attempts: readonly Attempt[], exById: ReadonlyMap<string, Exercise>): OverclickReport {
  const g = groupStats(attempts)
  let zeroPassages = 0
  let clicksOnZero = 0
  for (const a of attempts) {
    const ex = exById.get(a.exerciseId)
    if (ex && !ex.tokens.some((t) => t.isIncorrect)) {
      zeroPassages++
      clicksOnZero += a.summary.score.falsePositives
    }
  }
  const fpPer = g.n ? g.falsePositives / g.n : 0
  let profile: ClickProfile = 'balanced'
  if (fpPer >= 0.5 || (g.precision !== null && g.precision < 0.8)) profile = 'threshold'
  else if (g.recall !== null && g.recall < 0.75) profile = (g.missesDuringLossShare ?? 0) >= 0.5 ? 'tracking' : 'discrimination'
  return {
    passages: g.n,
    zeroPassages,
    clicksOnZero,
    falseClicks: g.falsePositives,
    hits: g.hits,
    mismatches: g.mismatches,
    pointsLost: g.falsePositives,
    net: attempts.reduce((n, a) => n + a.summary.score.net, 0),
    precision: g.precision,
    recall: g.recall,
    missesDuringLossShare: g.missesDuringLossShare,
    profile,
  }
}

// ── Where the points went ────────────────────────────────────────────────

export interface PointLoss {
  /** 'false-clicks' | 'lost-sync' | 'late' | `trap:<category>` */
  source: string
  points: number
}

/** Points lost per source across attempts: −1 per false click, 1 missed point per miss (by likely cause). */
export function pointLosses(attempts: readonly Attempt[], exById: ReadonlyMap<string, Exercise>): PointLoss[] {
  const m = new Map<string, number>()
  const add = (k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n)
  for (const a of attempts) {
    const ex = exById.get(a.exerciseId)
    if (!ex || !isHiwAttempt(a)) continue
    if (a.summary.score.falsePositives) add('false-clicks', a.summary.score.falsePositives)
    for (const r of mismatchRows(ex, a)) {
      if (r.selected) continue
      if (r.causes.includes('lost-sync') || r.causes.includes('drifting')) add('lost-sync')
      else add(`trap:${r.token.trapCategory ?? 'semantic'}`)
    }
  }
  return [...m.entries()].map(([source, points]) => ({ source, points })).sort((a, b) => b.points - a.points)
}

// ── Session summary & rolling diagnosis ──────────────────────────────────

export interface Delta {
  metric: 'precision' | 'recall' | 'within2' | 'fpPerPassage'
  now: number
  before: number
  /** Positive = better, in percentage points (fpPerPassage: fewer false clicks is better). */
  change: number
}

function fpPer(g: GroupStats): number | null {
  return g.n ? g.falsePositives / g.n : null
}

export function compare(now: readonly Attempt[], before: readonly Attempt[]): Delta[] {
  const a = groupStats(now.filter(isHiwAttempt))
  const b = groupStats(before.filter(isHiwAttempt))
  const sa = groupStats(now)
  const sb = groupStats(before)
  const out: Delta[] = []
  const push = (metric: Delta['metric'], x: number | null, y: number | null, invert = false) => {
    if (x === null || y === null) return
    out.push({ metric, now: x, before: y, change: Math.round((invert ? y - x : x - y) * 100) })
  }
  push('precision', a.precision, b.precision)
  push('recall', a.recall, b.recall)
  push('within2', sa.within2, sb.within2)
  push('fpPerPassage', fpPer(a), fpPer(b), true)
  return out
}

export interface SessionSummary {
  attempts: number
  net: number
  maxNet: number
  stats: GroupStats
  improved: Delta[]
  worse: Delta[]
  losses: PointLoss[]
  tomorrow: Focus[]
}

/**
 * End-of-session report: what improved (vs the previous 7 days), what cost the most points,
 * and what tomorrow will focus on.
 */
export function sessionSummary(
  today: readonly Attempt[],
  previous: readonly Attempt[],
  allRecent: readonly Attempt[],
  exById: ReadonlyMap<string, Exercise>,
): SessionSummary {
  const deltas = compare(today, previous)
  const hiw = today.filter(isHiwAttempt)
  return {
    attempts: today.length,
    net: hiw.reduce((n, a) => n + a.summary.score.net, 0),
    maxNet: hiw.reduce((n, a) => n + a.summary.score.mismatches, 0),
    stats: groupStats(hiw),
    improved: deltas.filter((d) => d.change >= 5).sort((a, b) => b.change - a.change),
    worse: deltas.filter((d) => d.change <= -5).sort((a, b) => a.change - b.change),
    losses: pointLosses(today, exById).slice(0, 3),
    tomorrow: weaknesses(allRecent),
  }
}

/** Written diagnosis for a window of attempts vs the window before it. */
export function rollingDiagnosis(window: readonly Attempt[], before: readonly Attempt[], exById: ReadonlyMap<string, Exercise>): Coaching[] {
  const hiw = window.filter(isHiwAttempt)
  const g = groupStats(hiw)
  const sync = groupStats(window)
  const deltas = new Map(compare(window, before).map((d) => [d.metric, d.change]))
  const out: Coaching[] = []
  const trend = (m: Delta['metric']) => {
    const c = deltas.get(m)
    return c === undefined || Math.abs(c) < 3 ? '' : ` (${c > 0 ? '+' : ''}${c})`
  }
  if (g.recall !== null && g.selections > 0) {
    const fpShare = g.falsePositives / g.selections
    out.push({
      key: 'diag.catchAndFalse',
      params: { recall: pct(g.recall), fp: pct(fpShare), n: hiw.length, rTrend: trend('recall'), pTrend: trend('precision') },
      tone: fpShare <= 0.1 && g.recall >= 0.85 ? 'good' : fpShare > 0.2 ? 'warn' : 'info',
    })
  }
  if (sync.within2 !== null) {
    out.push({
      key: 'diag.sync',
      params: { pct: pct(sync.within2), trend: trend('within2') },
      tone: sync.within2 >= 0.9 ? 'good' : sync.within2 < 0.75 ? 'warn' : 'info',
    })
  }
  if (g.misses > 0 && g.missesDuringLossShare !== null && g.missesDuringLossShare >= 0.3) {
    out.push({ key: 'diag.lossMisses', params: { pct: pct(g.missesDuringLossShare) }, tone: 'warn' })
  }
  const top = pointLosses(window, exById)[0]
  if (top) {
    const [kind, cat] = top.source.split(':')
    out.push({
      key: kind === 'trap' ? 'diag.topLossTrap' : `diag.topLoss.${kind}`,
      params: { n: top.points, cat: (cat as TrapCategory) ?? '' },
      tone: 'info',
    })
  }
  const main = weaknesses(window)[0]
  if (main && main.type !== 'baseline') {
    out.push({ key: main.type === 'trap' ? 'focus.trap' : `focus.${main.type}`, params: main.type === 'trap' ? { cat: main.category } : undefined, tone: 'warn' })
  }
  return out
}
