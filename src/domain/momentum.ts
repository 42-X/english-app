import { isHiwAttempt, targetLevel, weaknesses } from './adaptive'
import { hasTrap, localDate, passage, sparse, suggestExercise } from './plan'
import { isDue, REVIEW_SESSION } from './srs'
import type { Attempt, Exercise, ListeningAttempt, MistakeItem, TrapCategory } from './types'

// Motivation: effort-based measures that only grow (days practised, points earned — never a streak
// to lose), results judged against her own recent average rather than an absolute bar, and always
// a concrete next step.

/** Longest time one item can count for, so a question left open doesn't inflate practice time. */
const MAX_ITEM_MS = 10 * 60_000

export interface Session {
  at: number
  ms: number
}

export function sessions(attempts: readonly Attempt[], listening: readonly ListeningAttempt[]): Session[] {
  return [...attempts, ...listening].map((a) => ({ at: a.completedAt, ms: Math.min(MAX_ITEM_MS, Math.max(0, a.completedAt - a.startedAt)) }))
}

export function activeDays(s: readonly Session[]): Set<string> {
  return new Set(s.map((x) => localDate(x.at)))
}

/** Lifetime-points milestones; after the list, every further 2,500. */
const MILESTONES = [25, 50, 100, 250, 500, 750, 1000, 1500, 2000, 2500]

/** The milestone below and the one to aim for next. */
export function milestone(points: number): { prev: number; next: number } {
  let prev = 0
  for (const m of MILESTONES) {
    if (points < m) return { prev, next: m }
    prev = m
  }
  const next = (Math.floor(points / 2500) + 1) * 2500
  return { prev: next - 2500, next }
}

/** A milestone reached by today's practice (`before` = points at the start of the day), if any. */
export function milestoneReachedToday(before: number, now: number): number | null {
  const m = milestone(now).prev
  return m > before ? m : null
}

/** The last seven days, oldest first, ending today. */
export function lastSevenDays(days: ReadonlySet<string>, now: number): { date: string; active: boolean; today: boolean }[] {
  const out = []
  for (let k = 6; k >= 0; k--) {
    const d = new Date(now)
    d.setDate(d.getDate() - k)
    const date = localDate(d.getTime())
    out.push({ date, active: days.has(date), today: k === 0 })
  }
  return out
}

export interface Wins {
  /** Questions / sets finished. */
  done: number
  minutes: number
  /** HIW changed words caught. */
  caught: number
  /** FIB-L / WFD words written correctly. */
  written: number
  /** HIW passages with everything caught and no extra clicks (incl. correctly leaving a clean passage alone). */
  perfect: number
}

export function wins(attempts: readonly Attempt[], listening: readonly ListeningAttempt[], since = 0): Wins {
  const a = attempts.filter((x) => x.completedAt >= since)
  const l = listening.filter((x) => x.completedAt >= since)
  const hiw = a.filter(isHiwAttempt)
  return {
    done: a.length + l.length,
    minutes: Math.round(sessions(a, l).reduce((n, s) => n + s.ms, 0) / 60_000),
    caught: hiw.reduce((n, x) => n + x.summary.score.hits, 0),
    written: l.reduce((n, x) => n + x.correct, 0),
    perfect: hiw.filter((x) => isPerfect(x)).length,
  }
}

function isPerfect(a: Attempt): boolean {
  const s = a.summary.score
  return s.hits === s.mismatches && s.falsePositives === 0
}

/** Share of the available points earned on one HIW question (a clean passage left alone counts as 1). */
export function hiwRatio(a: Attempt): number {
  const s = a.summary.score
  if (s.mismatches === 0) return s.falsePositives === 0 ? 1 : 0
  return s.net / s.mismatches
}

export type Mood = 'perfect' | 'better' | 'good' | 'steady' | 'tough'

/**
 * How a result should be framed. Compared with her own recent results first, so a hard passage at
 * her usual level reads as "steady", not as failure.
 */
export function resultMood(ratio: number, perfect: boolean, recent: readonly number[]): Mood {
  if (perfect) return 'perfect'
  const avg = recent.length >= 3 ? recent.reduce((x, y) => x + y, 0) / recent.length : null
  if (avg !== null && ratio >= avg + 0.1) return 'better'
  if (ratio >= 0.6) return 'good'
  if (avg !== null && ratio >= avg - 0.1) return 'steady'
  return 'tough'
}

export function hiwMood(a: Attempt, history: readonly Attempt[]): Mood {
  const recent = history
    .filter((x) => x.id !== a.id && isHiwAttempt(x) && x.completedAt < a.completedAt)
    .slice(0, 10)
    .map(hiwRatio)
  return resultMood(hiwRatio(a), isPerfect(a), recent)
}

export function listeningMood(a: ListeningAttempt, history: readonly ListeningAttempt[]): Mood {
  const ratio = (x: ListeningAttempt) => x.correct / Math.max(1, x.total)
  const recent = history
    .filter((x) => x.id !== a.id && x.task === a.task && x.completedAt < a.completedAt)
    .slice(0, 10)
    .map(ratio)
  return resultMood(ratio(a), a.total > 0 && a.correct === a.total, recent)
}

// ── What to do next ────────────────────────────────────────────────────

export type Rec =
  /** `due`: cards in the next Quick review session (capped at one session). */
  | { kind: 'review'; due: number }
  | { kind: 'trap'; category: TrapCategory; exerciseId: string }
  | { kind: 'overclicking' | 'tracking' | 'latency' | 'discrimination' | 'exam' | 'practice'; exerciseId: string }
  | { kind: 'fibl'; exerciseId: string }
  | { kind: 'wfd' }
  | { kind: 'words'; learning: number }

export interface RecInput {
  exercises: readonly Exercise[]
  /** Most recent first. */
  attempts: readonly Attempt[]
  /** Most recent first. */
  listening: readonly ListeningAttempt[]
  mistakes: readonly MistakeItem[]
  learningWords: number
  now: number
}

const DAY = 86_400_000

/**
 * Up to `max` concrete next steps, each a single tap away, most useful first. Quick wins (due
 * review) come before harder work so a session can start with success.
 */
export function recommendations(input: RecInput, max = 3): Rec[] {
  const { exercises, attempts, listening, now } = input
  const out: Rec[] = []
  const used = new Set<string>()
  const pick = (pred: (e: Exercise) => boolean) => {
    const ex = suggestExercise(exercises, attempts, (e) => !used.has(e.id) && pred(e))
    if (ex) used.add(ex.id)
    return ex?.id
  }
  const push = (r: Rec | null) => {
    if (r && out.length < max) out.push(r)
  }

  const due = input.mistakes.filter((m) => isDue(m, now)).length
  if (due >= 3) push({ kind: 'review', due: Math.min(due, REVIEW_SESSION) })

  for (const f of weaknesses(attempts).slice(0, 2)) {
    if (f.type === 'baseline') continue
    const id = f.type === 'trap' ? pick((e) => hasTrap(e, f.category)) : pick(f.type === 'overclicking' ? sparse : passage)
    if (!id) continue
    push(f.type === 'trap' ? { kind: 'trap', category: f.category, exerciseId: id } : { kind: f.type, exerciseId: id })
  }

  // FIB-L / WFD: whichever is weaker, or hasn't been practised for two days.
  const recentAcc = (task: ListeningAttempt['task']) => {
    const xs = listening.filter((a) => a.task === task).slice(0, 5)
    const total = xs.reduce((n, a) => n + a.total, 0)
    return { acc: total ? xs.reduce((n, a) => n + a.correct, 0) / total : null, last: xs[0]?.completedAt ?? 0 }
  }
  const fibl = recentAcc('fibl')
  const wfd = recentAcc('wfd')
  const fiblFirst = (fibl.acc ?? 0) <= (wfd.acc ?? 0) || now - fibl.last > 2 * DAY
  const fiblId = pick((e) => e.tags.includes('human-audio') && e.kind !== 'overclick')
  const listeningRecs: Rec[] = [...(fiblId ? [{ kind: 'fibl' as const, exerciseId: fiblId }] : []), { kind: 'wfd' }]
  push(fiblFirst ? listeningRecs[0] : listeningRecs[listeningRecs.length - 1])

  if (due > 0 && due < 3) push({ kind: 'review', due })
  if (input.learningWords >= 5) push({ kind: 'words', learning: input.learningWords })

  // Nothing specific to fix: a realistic passage, or exam conditions once she's steady.
  if (out.length < max) {
    const steady = attempts.filter(isHiwAttempt).length >= 3 && targetLevel(attempts) >= 2
    const id = pick((e) => e.kind === 'realistic')
    if (id) push({ kind: steady ? 'exam' : 'practice', exerciseId: id })
  }
  if (out.length < max) push(listeningRecs.find((r) => !out.some((o) => o.kind === r.kind)) ?? null)
  return out
}

/** Change in FIB-L / WFD accuracy (percentage points), this week vs the week before; null without both. */
export function accuracyChange(listening: readonly ListeningAttempt[], task: ListeningAttempt['task'], weekStart: number): number | null {
  const acc = (xs: readonly ListeningAttempt[]) => {
    const total = xs.reduce((n, a) => n + a.total, 0)
    return total ? xs.reduce((n, a) => n + a.correct, 0) / total : null
  }
  const mine = listening.filter((a) => a.task === task)
  const now = acc(mine.filter((a) => a.completedAt >= weekStart))
  const before = acc(mine.filter((a) => a.completedAt < weekStart && a.completedAt >= weekStart - 7 * DAY))
  return now === null || before === null ? null : Math.round((now - before) * 100)
}
