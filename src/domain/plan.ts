import { targetLevel, weaknesses } from './adaptive'
import { isDue } from './srs'
import type { WfdSentence } from './listening'
import type { Attempt, DailyPlan, Exercise, Focus, MistakeItem, Mode, PlanItem, TrapCategory } from './types'

export interface PlanInput {
  date: string
  exercises: readonly Exercise[]
  /** Most recent first. */
  attempts: readonly Attempt[]
  mistakes: readonly MistakeItem[]
  speed: number
  now: number
  /** FIB-L / WFD history; when given, the plan includes those tasks. */
  listening?: {
    /** Last FIB-L attempt time per passage. */
    fiblLast: ReadonlyMap<string, number>
    /** Recent FIB-L accuracy (0–1), or null with no data. */
    fiblAccuracy: number | null
    wfd: readonly WfdSentence[]
    /** Last time each WFD sentence was dictated. */
    wfdLast: ReadonlyMap<string, number>
  }
}

export const WFD_SET = 6

export function isHuman(ex: Exercise): boolean {
  return ex.tags.includes('human-audio')
}

export function hasTrap(ex: Exercise, cat: TrapCategory): boolean {
  return ex.tokens.some((t) => t.isIncorrect && t.trapCategory === cat)
}

export function mismatchCount(ex: Exercise): number {
  return ex.tokens.reduce((n, t) => n + (t.isIncorrect ? 1 : 0), 0)
}

/** Least-recently-used first; never-attempted first of all. Human recordings before synthetic. */
function lruOrder(exercises: readonly Exercise[], attempts: readonly Attempt[]): Exercise[] {
  const last = new Map<string, number>()
  for (const a of attempts) if (!last.has(a.exerciseId)) last.set(a.exerciseId, a.completedAt)
  return [...exercises].sort(
    (x, y) => (last.get(x.id) ?? 0) - (last.get(y.id) ?? 0) || Number(isHuman(y)) - Number(isHuman(x)) || x.id.localeCompare(y.id),
  )
}

export function buildDailyPlan(input: PlanInput): DailyPlan {
  const { exercises, attempts, speed, now } = input
  const focus = weaknesses(attempts)
  const level = targetLevel(attempts)
  const used = new Set<string>()
  const items: PlanItem[] = []
  const library = exercises.filter((e) => !e.custom && !e.archived)
  const ordered = lruOrder(library, attempts)

  /** First unused match, preferring the learner's current difficulty level, then the nearest one. */
  const pick = (pred: (e: Exercise) => boolean, preferLevel = true): Exercise | undefined => {
    const pool = ordered.filter((e) => !used.has(e.id) && pred(e))
    const ex = preferLevel ? [...pool].sort((a, b) => Math.abs((a.difficulty ?? 2) - level) - Math.abs((b.difficulty ?? 2) - level))[0] : pool[0]
    if (ex) used.add(ex.id)
    return ex
  }
  const add = (ex: Exercise | undefined, mode: Mode, block: PlanItem['block'], reason: string, s = speed) => {
    if (ex) items.push({ exerciseId: ex.id, mode, speed: s, block, reason })
  }
  const has = (t: Focus['type']) => focus.some((f) => f.type === t)
  const trapFoci = focus.filter((f): f is Extract<Focus, { type: 'trap' }> => f.type === 'trap')
  const passage = (e: Exercise) => e.kind === 'realistic' || e.kind === 'easy' || e.kind === 'recovery' || e.kind === 'guided'
  const sparse = (e: Exercise) => e.kind === 'overclick'
  const long = (e: Exercise) => passage(e) && e.tokens.length >= 95

  // 1. Warm-up synchronization (~5 min), always at 1.0×. Easier passages when tracking is the problem.
  if (has('tracking') || has('baseline')) {
    add(pick((e) => passage(e) && (e.difficulty ?? 2) <= 2), 'guided', 'warmup', 'warmup', 1)
    add(pick(passage), 'fading', 'warmup', 'fading', 1)
  } else {
    add(pick(passage), 'fading', 'warmup', 'fading', 1)
  }

  // 2. Weak-spot drills (~5 min): full-length passages containing the weak trap type.
  if (has('overclicking')) {
    add(pick(sparse), 'overclick', 'drill', 'overclick')
    add(pick(sparse), 'overclick', 'drill', 'overclick')
  }
  for (const f of trapFoci.slice(0, has('overclicking') ? 1 : 2)) {
    add(pick((e) => hasTrap(e, f.category)), 'drill', 'drill', `trap:${f.category}`)
  }
  if (has('tracking')) add(pick(long) ?? pick(passage), 'recovery', 'drill', 'recovery', 1)
  if (has('latency') || has('baseline')) add(pick(passage), 'practice', 'drill', has('baseline') ? 'baseline' : 'latency')
  if (has('discrimination') && trapFoci.length === 0) add(pick(passage), 'drill', 'drill', 'discrimination')
  if (!items.some((i) => i.block === 'drill')) add(pick(passage), 'drill', 'drill', 'variety')

  // 3. Realistic HIW (~7–10 min) at her level; the last one under exam conditions.
  add(pick((e) => e.kind === 'realistic'), 'practice', 'realistic', 'realistic')
  add(pick((e) => e.kind === 'realistic' || sparse(e)), 'practice', 'realistic', 'realistic')
  add(pick((e) => e.kind === 'realistic'), 'exam', 'realistic', 'exam')

  // 4. Listening tasks: FIB-L (passage with blanks) and a WFD set (dictation). These carry most of
  //    the Listening score alongside HIW. Extra FIB-L when its accuracy is low.
  const L = input.listening
  if (L) {
    const fibl = library
      .filter((e) => isHuman(e) && !used.has(e.id) && e.kind !== 'overclick')
      .sort((a, b) => (L.fiblLast.get(a.id) ?? 0) - (L.fiblLast.get(b.id) ?? 0) || a.id.localeCompare(b.id))
    const nFibl = L.fiblAccuracy !== null && L.fiblAccuracy < 0.7 ? 2 : 1
    for (const ex of fibl.slice(0, nFibl)) {
      used.add(ex.id)
      items.push({ exerciseId: ex.id, mode: 'practice', speed: 1, block: 'fibl', task: 'fibl', reason: 'fibl' })
    }
    const seed = [...input.date].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
    const wfd = [...L.wfd]
      .sort((a, b) => (L.wfdLast.get(a.id) ?? 0) - (L.wfdLast.get(b.id) ?? 0) || (((seed ^ a.from) % 97) - ((seed ^ b.from) % 97)))
      .slice(0, WFD_SET)
    if (wfd.length) items.push({ exerciseId: wfd[0].exerciseId, mode: 'practice', speed: 1, block: 'wfd', task: 'wfd', reason: 'wfd', sentences: wfd.map((x) => x.id) })
  }

  // 5. Mistake-bank review (~3–5 min) with *different* passages containing the same confusions.
  const due = input.mistakes.filter((m) => isDue(m, now))
  const dueCats = [...new Set(due.map((m) => m.trapCategory).filter((c): c is TrapCategory => !!c))]
  for (const cat of dueCats.slice(0, 2)) {
    const origin = new Set(due.filter((m) => m.trapCategory === cat).map((m) => m.exerciseId))
    add(pick((e) => hasTrap(e, cat) && !origin.has(e.id)) ?? pick((e) => hasTrap(e, cat)), 'review', 'review', `review:${cat}`)
  }
  if (due.some((m) => m.type === 'false-positive') && dueCats.length < 2) {
    add(pick(sparse), 'review', 'review', 'review:false-positive')
  }

  return { id: `plan-${input.date}`, kind: 'daily', date: input.date, focus, items, createdAt: now, updatedAt: now }
}

/**
 * Over-clicking diagnostic: 10 passages with 0–2 hidden mismatches, run back-to-back under exam
 * conditions. Mix favours zero/one-mismatch passages so unnecessary clicks show up clearly.
 */
export function buildOverclickTest(input: Omit<PlanInput, 'mistakes' | 'speed'>, size = 10): DailyPlan | null {
  const ordered = lruOrder(
    input.exercises.filter((e) => !e.custom && !e.archived && mismatchCount(e) <= 2),
    input.attempts,
  )
  const by = (n: number) => ordered.filter((e) => mismatchCount(e) === n)
  const want: [number, number][] = [
    [0, 3],
    [1, 4],
    [2, 3],
  ]
  const chosen: Exercise[] = []
  for (const [n, k] of want) chosen.push(...by(n).slice(0, k))
  for (const e of ordered) if (chosen.length < size && !chosen.includes(e)) chosen.push(e)
  if (chosen.length < 6) return null
  // Deterministic shuffle so the mismatch count can't be inferred from position.
  const items = chosen
    .slice(0, size)
    .map((e, i) => ({ e, k: (i * 7919 + input.now) % 101 }))
    .sort((a, b) => a.k - b.k)
    .map(({ e }) => ({ exerciseId: e.id, mode: 'overclick' as Mode, speed: 1, block: 'realistic' as const, reason: 'overclick' }))
  return { id: `test-${input.now}`, kind: 'overclick-test', date: input.date, focus: [], items, createdAt: input.now, updatedAt: input.now }
}

export function estimatedMinutes(plan: DailyPlan, exercises: ReadonlyMap<string, Exercise>): number {
  let ms = 0
  for (const i of plan.items) {
    const ex = exercises.get(i.exerciseId)
    if (i.task === 'wfd') {
      ms += (i.sentences?.length ?? WFD_SET) * 35_000
      continue
    }
    // countdown + audio + time reviewing results (FIB-L: plus typing/checking)
    ms += (ex ? ex.durationMs / i.speed : 45_000) + 7_000 + (plan.kind === 'overclick-test' ? 10_000 : i.task === 'fibl' ? 100_000 : 75_000)
  }
  return Math.round(ms / 60_000)
}

export function localDate(now = Date.now()): string {
  const d = new Date(now)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
