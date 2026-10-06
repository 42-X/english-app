import type { MistakeItem, TrapCategory } from './types'

const MIN = 60_000
const DAY = 24 * 60 * MIN

/** Review intervals after each successful step: 10 min, 1 day, 3 days, 7 days. */
export const INTERVALS = [10 * MIN, DAY, 3 * DAY, 7 * DAY] as const
export const MASTERED = INTERVALS.length

export function mistakeId(type: MistakeItem['type'], display: string, spoken: string): string {
  return `${type}:${display.toLowerCase()}>${spoken.toLowerCase()}`
}

export interface NewMistake {
  type: MistakeItem['type']
  display: string
  spoken: string
  trapCategory?: TrapCategory
  exerciseId: string
  tokenIndex: number
  context: string
}

/** Add a new mistake, or fold a repeat into the existing item (a relapse restarts the schedule). */
export function recordMistake(existing: MistakeItem | undefined, m: NewMistake, now: number): MistakeItem {
  if (existing) {
    const relapsed = existing.step > 0
    return {
      ...existing,
      exerciseId: m.exerciseId,
      tokenIndex: m.tokenIndex,
      context: m.context,
      step: 0,
      lapses: existing.lapses + (relapsed ? 1 : 0),
      dueAt: relapsed ? now + INTERVALS[0] : Math.min(existing.dueAt, now + INTERVALS[0]),
      updatedAt: now,
    }
  }
  return {
    id: mistakeId(m.type, m.display, m.spoken),
    ...m,
    createdAt: now,
    step: 0,
    dueAt: now + INTERVALS[0],
    lapses: 0,
    updatedAt: now,
  }
}

export function reviewMistake(item: MistakeItem, success: boolean, now: number): MistakeItem {
  if (!success) {
    return { ...item, step: 0, lapses: item.lapses + 1, dueAt: now + INTERVALS[0], lastReviewedAt: now, updatedAt: now }
  }
  const step = Math.min(MASTERED, item.step + 1)
  const dueAt = step >= MASTERED ? now + 30 * DAY : now + INTERVALS[step]
  return { ...item, step, dueAt, lastReviewedAt: now, updatedAt: now }
}

export function isDue(item: MistakeItem, now: number): boolean {
  return item.step < MASTERED && item.dueAt <= now
}
