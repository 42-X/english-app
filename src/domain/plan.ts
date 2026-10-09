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

/** Shared exercise picking for the daily quest and bonus rounds. */
function planner(input: PlanInput, exclude: ReadonlySet<string>, bonus: boolean) {
  const { exercises, attempts, speed } = input
  const focus = weaknesses(attempts)
  const level = targetLevel(attempts)
  const used = new Set(exclude)
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
    if (ex) items.push({ exerciseId: ex.id, mode, speed: s, block, reason, ...(bonus ? { bonus: true } : {}) })
  }
  const has = (t: Focus['type']) => focus.some((f) => f.type === t)
  /** Struggling right now: keep exam conditions out until things feel steadier. */
  const struggling = level === 1 || has('tracking')

  /** One weak-spot item for focus `f` (rotates through her weaknesses across bonus rounds). */
  const drill = (f: Focus | undefined) => {
    if (!f || f.type === 'baseline') return add(pick(passage), 'practice', 'drill', f ? 'baseline' : 'variety')
    if (f.type === 'overclicking') return add(pick(sparse), 'overclick', 'drill', 'overclick')
    if (f.type === 'trap') {
      // A weakness from older passages whose swap type the library no longer uses (e.g. plurals): any passage.
      const ex = pick((e) => hasTrap(e, f.category))
      return ex ? add(ex, 'drill', 'drill', `trap:${f.category}`) : add(pick(passage), 'practice', 'drill', 'variety')
    }
    if (f.type === 'tracking') return add(pick(long) ?? pick(passage), 'recovery', 'drill', 'recovery', 1)
    if (f.type === 'latency') return add(pick(passage), 'practice', 'drill', 'latency')
    return add(pick(passage), 'drill', 'drill', 'discrimination')
  }

  /** FIB-L passages and one WFD set, avoiding sentences already in `skipSentences`. */
  const listening = (nFibl: number, skipSentences: ReadonlySet<string> = new Set()) => {
    const L = input.listening
    if (!L) return
    const fibl = library
      .filter((e) => isHuman(e) && !used.has(e.id) && e.kind !== 'overclick')
      .sort((a, b) => (L.fiblLast.get(a.id) ?? 0) - (L.fiblLast.get(b.id) ?? 0) || a.id.localeCompare(b.id))
    for (const ex of fibl.slice(0, nFibl)) {
      used.add(ex.id)
      items.push({ exerciseId: ex.id, mode: 'practice', speed: 1, block: 'fibl', task: 'fibl', reason: 'fibl', ...(bonus ? { bonus: true } : {}) })
    }
    const seed = [...input.date].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7 + skipSentences.size)
    const wfd = L.wfd
      .filter((x) => !skipSentences.has(x.id))
      .sort((a, b) => (L.wfdLast.get(a.id) ?? 0) - (L.wfdLast.get(b.id) ?? 0) || ((seed ^ a.from) % 97) - ((seed ^ b.from) % 97))
      .slice(0, WFD_SET)
    if (wfd.length) {
      items.push({ exerciseId: wfd[0].exerciseId, mode: 'practice', speed: 1, block: 'wfd', task: 'wfd', reason: 'wfd', sentences: wfd.map((x) => x.id), ...(bonus ? { bonus: true } : {}) })
    }
  }

  /** Mistake-bank review with a *different* passage containing the same confusion. */
  const review = (max: number) => {
    const due = input.mistakes.filter((m) => isDue(m, input.now))
    const dueCats = [...new Set(due.map((m) => m.trapCategory).filter((c): c is TrapCategory => !!c))]
    for (const cat of dueCats.slice(0, max)) {
      const origin = new Set(due.filter((m) => m.trapCategory === cat).map((m) => m.exerciseId))
      add(pick((e) => hasTrap(e, cat) && !origin.has(e.id)) ?? pick((e) => hasTrap(e, cat)), 'review', 'review', `review:${cat}`)
    }
    if (dueCats.length < max && due.some((m) => m.type === 'false-positive')) add(pick(sparse), 'review', 'review', 'review:false-positive')
  }

  return { focus, level, struggling, items, has, pick, add, drill, listening, review }
}

export const passage = (e: Exercise) => e.kind === 'realistic' || e.kind === 'easy' || e.kind === 'recovery' || e.kind === 'guided'
export const sparse = (e: Exercise) => e.kind === 'overclick'
const long = (e: Exercise) => passage(e) && e.tokens.length >= 95

/** One exercise for a standalone recommendation: least recently used, closest to her level. */
export function suggestExercise(exercises: readonly Exercise[], attempts: readonly Attempt[], pred: (e: Exercise) => boolean): Exercise | undefined {
  const level = targetLevel(attempts)
  const pool = lruOrder(
    exercises.filter((e) => !e.custom && !e.archived && pred(e)),
    attempts,
  )
  // Stable sort keeps least-recently-used first among equally suitable levels.
  return [...pool].sort((a, b) => Math.abs((a.difficulty ?? 2) - level) - Math.abs((b.difficulty ?? 2) - level))[0]
}

/** Block order on the page and in play order. */
const BLOCK_ORDER: PlanItem['block'][] = ['warmup', 'drill', 'realistic', 'fibl', 'wfd', 'review']
const byBlock = (items: PlanItem[]) => [...items].sort((a, b) => BLOCK_ORDER.indexOf(a.block) - BLOCK_ORDER.indexOf(b.block))

/**
 * The daily quest: a short (~15 min), finishable session — warm-up → one weak-spot drill → a realistic
 * passage → FIB-L → a WFD set → review or exam conditions. Finishing it should feel achievable every day;
 * more practice comes from bonus rounds (`buildBonusRound`), not from a longer quest.
 */
export function buildDailyPlan(input: PlanInput): DailyPlan {
  const p = planner(input, new Set(), false)
  const { focus } = p

  // Warm-up synchronization at 1.0×. Easier passages when tracking is the problem.
  if (p.has('tracking') || p.has('baseline')) p.add(p.pick((e) => passage(e) && (e.difficulty ?? 2) <= 2), 'guided', 'warmup', 'warmup', 1)
  else p.add(p.pick(passage), 'fading', 'warmup', 'fading', 1)

  p.drill(focus[0])
  p.add(p.pick((e) => e.kind === 'realistic'), 'practice', 'realistic', 'realistic')
  p.listening(1)

  // Last slot: due review first; otherwise exam conditions — but only when she isn't struggling.
  const before = p.items.length
  p.review(1)
  if (p.items.length === before) {
    if (p.struggling) p.add(p.pick((e) => e.kind === 'realistic') ?? p.pick(passage), 'practice', 'realistic', 'realistic')
    else p.add(p.pick((e) => e.kind === 'realistic'), 'exam', 'realistic', 'exam')
  }

  return { id: `plan-${input.date}`, kind: 'daily', date: input.date, focus, items: byBlock(p.items), createdAt: input.now, updatedAt: input.now }
}

/** Most items a daily quest holds. */
export const QUEST_MAX = 6

/**
 * Plans made before the daily quest existed held 8–12 items. Keep the first six as the quest and
 * mark the rest as bonus, so the day stays finishable; finished items stay finished. Null when no change is needed.
 */
export function trimLegacyQuest(plan: DailyPlan): DailyPlan | null {
  if (plan.kind === 'overclick-test' || plan.items.filter((i) => !i.bonus).length <= QUEST_MAX) return null
  let kept = 0
  const items = plan.items.map((i) => (i.bonus || kept++ < QUEST_MAX ? i : { ...i, bonus: true }))
  return { ...plan, items }
}

/**
 * "Keep going": a further ~10-minute round after (or alongside) the quest. Never repeats a passage
 * or WFD sentence already in today's plan, and rotates through her weaknesses round by round.
 */
export function buildBonusRound(input: PlanInput, plan: DailyPlan): PlanItem[] {
  const p = planner(input, new Set(plan.items.map((i) => i.exerciseId)), true)
  // Every round starts with one drill, so earlier bonus drills count the rounds so far.
  const round = plan.items.filter((i) => i.bonus && i.block === 'drill').length
  const real = p.focus.filter((f) => f.type !== 'baseline')

  p.drill(real.length ? real[round % real.length] : p.focus[0])
  const exam = !p.struggling && round % 2 === 1
  p.add(p.pick((e) => e.kind === 'realistic') ?? p.pick(passage), exam ? 'exam' : 'practice', 'realistic', exam ? 'exam' : 'realistic')
  p.listening(1, new Set(plan.items.flatMap((i) => i.sentences ?? [])))
  p.review(1)
  // A tiny library could run dry; fall back to anything not done today.
  if (p.items.length === 0) p.add(p.pick(() => true, false), 'practice', 'realistic', 'realistic')
  return byBlock(p.items)
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
