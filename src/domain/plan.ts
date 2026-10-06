import { weaknesses } from './adaptive'
import { isDue } from './srs'
import type { Attempt, DailyPlan, Exercise, ExerciseKind, Focus, MistakeItem, Mode, PlanItem, TrapCategory } from './types'

export interface PlanInput {
  date: string
  exercises: readonly Exercise[]
  /** Most recent first. */
  attempts: readonly Attempt[]
  mistakes: readonly MistakeItem[]
  speed: number
  now: number
}

export function isHuman(ex: Exercise): boolean {
  return ex.tags.includes('human-audio')
}

export function hasTrap(ex: Exercise, cat: TrapCategory): boolean {
  return ex.tokens.some((t) => t.isIncorrect && t.trapCategory === cat)
}

/** Least-recently-used first; never-attempted first of all. */
function lruOrder(exercises: readonly Exercise[], attempts: readonly Attempt[]): Exercise[] {
  const last = new Map<string, number>()
  for (const a of attempts) if (!last.has(a.exerciseId)) last.set(a.exerciseId, a.completedAt)
  return [...exercises].sort((x, y) => (last.get(x.id) ?? 0) - (last.get(y.id) ?? 0) || x.id.localeCompare(y.id))
}

export function buildDailyPlan(input: PlanInput): DailyPlan {
  const { exercises, attempts, speed, now } = input
  const focus = weaknesses(attempts)
  const used = new Set<string>()
  const items: PlanItem[] = []
  const library = exercises.filter((e) => !e.custom)
  const ordered = lruOrder(library, attempts)

  const pick = (pred: (e: Exercise) => boolean): Exercise | undefined => {
    const ex = ordered.find((e) => !used.has(e.id) && pred(e))
    if (ex) used.add(ex.id)
    return ex
  }
  const add = (ex: Exercise | undefined, mode: Mode, block: PlanItem['block'], reason: string, s = speed) => {
    if (ex) items.push({ exerciseId: ex.id, mode, speed: s, block, reason })
  }
  const ofKind = (...kinds: ExerciseKind[]) => (e: Exercise) => kinds.includes(e.kind)
  const has = (t: Focus['type']) => focus.some((f) => f.type === t)
  const trapFoci = focus.filter((f): f is Extract<Focus, { type: 'trap' }> => f.type === 'trap')

  // 1. Warm-up synchronization (~5 min). Tracking is always trained at 1.0x.
  if (has('tracking') || has('baseline')) {
    add(pick(ofKind('guided')), 'guided', 'warmup', 'warmup', 1)
    add(pick(ofKind('easy', 'realistic')), 'fading', 'warmup', 'fading', 1)
  } else {
    add(pick(ofKind('guided', 'easy')), 'fading', 'warmup', 'fading', 1)
  }

  // 2. Weak-category micro-drills (~5 min).
  if (has('overclicking')) {
    const oc = (e: Exercise) => e.kind === 'overclick'
    add(pick((e) => oc(e) && isHuman(e)) ?? pick(oc), 'overclick', 'drill', 'overclick')
    add(pick((e) => oc(e) && isHuman(e)) ?? pick(oc), 'overclick', 'drill', 'overclick')
  }
  for (const f of trapFoci.slice(0, has('overclicking') ? 1 : 2)) {
    add(pick((e) => e.kind === 'drill' && hasTrap(e, f.category)) ?? pick((e) => hasTrap(e, f.category)), 'drill', 'drill', `trap:${f.category}`)
  }
  if (has('tracking')) add(pick(ofKind('recovery')), 'recovery', 'drill', 'recovery', 1)
  if (has('latency') || has('baseline')) add(pick(ofKind('easy')), 'practice', 'drill', has('baseline') ? 'baseline' : 'latency')
  if (has('discrimination') && trapFoci.length === 0) add(pick(ofKind('drill')), 'drill', 'drill', 'discrimination')
  if (!items.some((i) => i.block === 'drill')) add(pick(ofKind('drill')), 'drill', 'drill', 'variety')

  // 3. Realistic HIW (~7–10 min); the last one under exam conditions. Human recordings first.
  const human = (...kinds: ExerciseKind[]) => (e: Exercise) => kinds.includes(e.kind) && isHuman(e)
  add(pick(human('realistic')) ?? pick(ofKind('realistic')), 'practice', 'realistic', 'realistic')
  add(pick(human('realistic', 'overclick')) ?? pick(ofKind('realistic', 'overclick')), 'practice', 'realistic', 'realistic')
  add(pick(human('realistic')) ?? pick(ofKind('realistic')), 'exam', 'realistic', 'exam')

  // 4. Mistake-bank review (~3–5 min) with *new* examples of the same confusions.
  const due = input.mistakes.filter((m) => isDue(m, now))
  const dueCats = [...new Set(due.map((m) => m.trapCategory).filter((c): c is TrapCategory => !!c))]
  for (const cat of dueCats.slice(0, 2)) {
    const origin = new Set(due.filter((m) => m.trapCategory === cat).map((m) => m.exerciseId))
    add(pick((e) => hasTrap(e, cat) && !origin.has(e.id)) ?? pick((e) => hasTrap(e, cat)), 'review', 'review', `review:${cat}`)
  }
  if (due.some((m) => m.type === 'false-positive') && dueCats.length < 2) {
    add(pick(ofKind('overclick')), 'review', 'review', 'review:false-positive')
  }

  return { id: `plan-${input.date}`, date: input.date, focus, items, createdAt: now, updatedAt: now }
}

export function estimatedMinutes(plan: DailyPlan, exercises: ReadonlyMap<string, Exercise>): number {
  let ms = 0
  for (const i of plan.items) {
    const ex = exercises.get(i.exerciseId)
    // audio + preview + time reviewing results
    ms += (ex ? ex.durationMs / i.speed : 40_000) + 10_000 + 75_000
  }
  return Math.round(ms / 60_000)
}

export function localDate(now = Date.now()): string {
  const d = new Date(now)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
