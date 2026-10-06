import { isHiwAttempt } from '../domain/adaptive'
import { contextAround, falsePositiveRows } from '../domain/analysis'
import { buildDailyPlan, hasTrap, localDate } from '../domain/plan'
import { isDue, recordMistake, reviewMistake } from '../domain/srs'
import type { Attempt, DailyPlan, Exercise, MistakeItem, Settings } from '../domain/types'
import { db, getMeta, setMeta, type AttemptRow } from './db'

export const DEFAULT_SETTINGS: Settings = {
  language: 'zh-TW',
  theme: 'system',
  speed: 1,
  fading: { full: 0.3, line: 0.3 },
  liveCoaching: true,
  examCountdownSec: 10,
  updatedAt: 0,
}

export async function loadSettings(): Promise<Settings> {
  const row = await db.settings.get('settings')
  if (!row) return DEFAULT_SETTINGS
  const { id: _id, dirty: _dirty, deleted: _deleted, ...s } = row
  return { ...DEFAULT_SETTINGS, ...s }
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch, updatedAt: Date.now() }
  await db.settings.put({ ...next, id: 'settings', dirty: 1 })
  return next
}

/** All non-deleted attempts, most recent first. */
export async function recentAttempts(limit?: number): Promise<Attempt[]> {
  let q = db.attempts.orderBy('completedAt').reverse().filter((a) => !a.deleted)
  if (limit) q = q.limit(limit)
  return q.toArray()
}

export async function liveMistakes(): Promise<MistakeItem[]> {
  return (await db.mistakes.toArray()).filter((m) => !m.deleted)
}

/**
 * Persist a finished attempt and update the mistake bank:
 *  1. due mistakes whose confusion appears in this exercise are reviewed (pass/fail),
 *  2. new misses and false positives are added.
 */
export async function saveAttempt(attempt: Attempt, ex: Exercise): Promise<void> {
  const now = attempt.completedAt
  await db.transaction('rw', db.attempts, db.mistakes, db.plans, async () => {
    await db.attempts.put({ ...attempt, dirty: 1 } satisfies AttemptRow)

    if (isHiwAttempt(attempt)) {
      const sel = new Set(attempt.selected)
      const all = await db.mistakes.toArray()
      for (const m of all) {
        if (m.deleted || !isDue(m, now)) continue
        let outcome: boolean | null = null
        if (m.type === 'miss' && m.trapCategory && hasTrap(ex, m.trapCategory)) {
          outcome = ex.tokens.filter((t) => t.isIncorrect && t.trapCategory === m.trapCategory).every((t) => sel.has(t.index))
        } else if (m.type === 'false-positive' && (attempt.mode === 'review' || attempt.mode === 'overclick')) {
          outcome = attempt.summary.score.falsePositives === 0
        }
        if (outcome !== null) await db.mistakes.put({ ...reviewMistake(m, outcome, now), dirty: 1 })
      }

      const newOnes = [
        ...ex.tokens
          .filter((t) => t.isIncorrect && !sel.has(t.index))
          .map((t) => ({ type: 'miss' as const, display: t.displayText, spoken: t.spokenText, trapCategory: t.trapCategory, tokenIndex: t.index })),
        ...falsePositiveRows(ex, attempt).map((r) => ({
          type: 'false-positive' as const,
          display: r.token.displayText,
          spoken: r.token.spokenText,
          trapCategory: undefined,
          tokenIndex: r.token.index,
        })),
      ]
      for (const n of newOnes) {
        const id = `${n.type}:${n.display.toLowerCase()}>${n.spoken.toLowerCase()}`
        const existing = await db.mistakes.get(id)
        const item = recordMistake(existing?.deleted ? undefined : existing, { ...n, exerciseId: ex.id, context: contextAround(ex.tokens, n.tokenIndex) }, now)
        await db.mistakes.put({ ...item, dirty: 1, deleted: undefined })
      }
    }

    if (attempt.planId) {
      const plan = await db.plans.get(attempt.planId)
      if (plan) {
        const items = plan.items.map((i) => (i.exerciseId === ex.id && !i.attemptId ? { ...i, attemptId: attempt.id } : i))
        await db.plans.put({ ...plan, items, updatedAt: now, dirty: 1 })
      }
    }
  })
}

export async function updateConfidence(attemptId: string, confidence: Attempt['confidence']): Promise<void> {
  await db.attempts.update(attemptId, { confidence, updatedAt: Date.now(), dirty: 1 })
}

export async function deleteMistake(id: string): Promise<void> {
  await db.mistakes.update(id, { deleted: 1, dirty: 1, updatedAt: Date.now() })
}

/** Today's plan, created on first request of the day. */
export async function todaysPlan(exercises: readonly Exercise[], speed: number, regenerate = false): Promise<DailyPlan> {
  const date = localDate()
  const id = `plan-${date}`
  const existing = await db.plans.get(id)
  if (existing && !existing.deleted && !regenerate) return existing
  const plan = buildDailyPlan({
    date,
    exercises,
    attempts: await recentAttempts(60),
    mistakes: await liveMistakes(),
    speed,
    now: Date.now(),
  })
  await db.plans.put({ ...plan, dirty: 1 })
  return plan
}

// ── Backup ──────────────────────────────────────────────────────────

interface Backup {
  app: 'hiw-trainer'
  version: 1
  exportedAt: number
  attempts: unknown[]
  mistakes: unknown[]
  plans: unknown[]
  customExercises: unknown[]
  settings: unknown[]
}

export async function exportBackup(): Promise<Blob> {
  const data: Backup = {
    app: 'hiw-trainer',
    version: 1,
    exportedAt: Date.now(),
    attempts: await db.attempts.toArray(),
    mistakes: await db.mistakes.toArray(),
    plans: await db.plans.toArray(),
    customExercises: await db.customExercises.toArray(),
    settings: await db.settings.toArray(),
  }
  return new Blob([JSON.stringify(data)], { type: 'application/json' })
}

/** Merge a backup: newer `updatedAt` wins per record; nothing local is lost. */
export async function importBackup(file: File): Promise<number> {
  const data = JSON.parse(await file.text()) as Backup
  if (data.app !== 'hiw-trainer') throw new Error('not-a-backup')
  let n = 0
  await db.transaction('rw', [db.attempts, db.mistakes, db.plans, db.customExercises, db.settings], async () => {
    for (const name of ['attempts', 'mistakes', 'plans', 'customExercises', 'settings'] as const) {
      const table = db[name] as unknown as import('dexie').Table<{ id: string; updatedAt: number }, string>
      for (const row of data[name] as { id: string; updatedAt: number }[]) {
        const cur = await table.get(row.id)
        if (!cur || (row.updatedAt ?? 0) > (cur.updatedAt ?? 0)) {
          await table.put({ ...row, dirty: 1 } as never)
          n++
        }
      }
    }
  })
  return n
}

export async function markOnboarded(): Promise<void> {
  await setMeta('onboarded', true)
}

export async function isOnboarded(): Promise<boolean> {
  return (await getMeta<boolean>('onboarded')) === true
}
