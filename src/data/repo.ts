import { isHiwAttempt } from '../domain/adaptive'
import { contextAround, falsePositiveRows } from '../domain/analysis'
import { extractWfd, MAX_NEW_SPELLING_PER_SET, worthReviewing } from '../domain/listening'
import { buildDailyPlan, buildOverclickTest, hasTrap, localDate, type PlanInput } from '../domain/plan'
import { isDue, recordMistake, reviewMistake } from '../domain/srs'
import type { Attempt, DailyPlan, Exercise, ListeningAttempt, MistakeItem, Settings, VocabEntry } from '../domain/types'
import { headword, parseDictionary, parseWiktionary, type DictionaryResult } from '../domain/vocab'
import { db, getMeta, setMeta, type AttemptRow } from './db'

export const DEFAULT_SETTINGS: Settings = {
  language: 'en',
  theme: 'system',
  speed: 1,
  fading: { full: 0.3, line: 0.3 },
  liveCoaching: true,
  countdownSec: 7,
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

    const sel = new Set(attempt.selected)
    // Spaced-review outcomes only from scored modes (warm-ups have on-screen help)…
    if (isHiwAttempt(attempt)) {
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
    }

    // …but every missed or wrongly-clicked word goes into the bank, in any mode with clickable words.
    if (attempt.mode !== 'guided') {
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

/** Quick-review result for one mistake (flashcard: heard it now / still hard). */
export async function reviewMistakeNow(id: string, success: boolean): Promise<void> {
  const m = await db.mistakes.get(id)
  if (m) await db.mistakes.put({ ...reviewMistake(m, success, Date.now()), dirty: 1 })
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
    listening: await listeningInput(exercises),
  })
  await db.plans.put({ ...plan, dirty: 1 })
  return plan
}

/** Create a 10-passage over-clicking diagnostic session; returns its id (null if not enough content). */
export async function startOverclickTest(exercises: readonly Exercise[]): Promise<DailyPlan | null> {
  const test = buildOverclickTest({ date: localDate(), exercises, attempts: await recentAttempts(200), now: Date.now() })
  if (test) await db.plans.put({ ...test, dirty: 1 })
  return test
}

/** Attempts belonging to a plan/test session, in play order. */
export async function sessionAttempts(plan: DailyPlan): Promise<Attempt[]> {
  const ids = plan.items.map((i) => i.attemptId).filter((x): x is string => !!x)
  const rows = await db.attempts.bulkGet(ids)
  return rows.filter((a): a is AttemptRow => !!a && !a.deleted)
}

/** FIB-L / WFD history in the shape the plan builder needs. */
async function listeningInput(exercises: readonly Exercise[]): Promise<PlanInput['listening']> {
  const hist = await recentListening(undefined, 300)
  const fiblLast = new Map<string, number>()
  const wfdLast = new Map<string, number>()
  for (const a of hist) {
    if (a.task === 'fibl' && !fiblLast.has(a.exerciseId)) fiblLast.set(a.exerciseId, a.completedAt)
    if (a.task === 'wfd') for (const it of a.items) if (!wfdLast.has(it.ref)) wfdLast.set(it.ref, a.completedAt)
  }
  const fibl = hist.filter((a) => a.task === 'fibl').slice(0, 5)
  const total = fibl.reduce((n, a) => n + a.total, 0)
  return {
    fiblLast,
    fiblAccuracy: total ? fibl.reduce((n, a) => n + a.correct, 0) / total : null,
    wfd: extractWfd(exercises),
    wfdLast,
  }
}

// ── FIB-L / WFD ─────────────────────────────────────────────────────

/**
 * Save a FIB-L or WFD result. Words she typed wrongly or missed go into the mistake bank as
 * "spelling" items (hear it → type it), and the matching plan item is ticked off.
 */
export async function saveListeningAttempt(a: ListeningAttempt, exById: ReadonlyMap<string, Exercise>): Promise<void> {
  const now = a.completedAt
  await db.transaction('rw', db.listening, db.mistakes, db.plans, async () => {
    await db.listening.put({ ...a, dirty: 1 })
    let added = 0
    for (const item of a.items) {
      const ex = exById.get(item.exerciseId)
      if (!ex) continue
      const words = a.task === 'fibl' ? [{ expected: item.expected, typed: item.typed, kind: item.kinds[0], index: Number(item.ref) }] : wfdWords(item, ex)
      for (const w of words) {
        if (w.index < 0 || !worthReviewing(w.expected, w.kind)) continue
        if (a.task === 'wfd' && ++added > MAX_NEW_SPELLING_PER_SET) break
        const typed = w.typed?.trim() || '—'
        const id = `spelling:${typed.toLowerCase()}>${w.expected.toLowerCase()}`
        const existing = await db.mistakes.get(id)
        const m = recordMistake(
          existing?.deleted ? undefined : existing,
          { type: 'spelling', display: typed, spoken: w.expected, exerciseId: ex.id, tokenIndex: w.index, context: contextAround(ex.tokens, w.index, 5, true) },
          now,
        )
        await db.mistakes.put({ ...m, dirty: 1, deleted: undefined })
      }
    }
    if (a.planId) {
      const plan = await db.plans.get(a.planId)
      if (plan) {
        let done = false
        const items = plan.items.map((i) => {
          if (done || i.attemptId || i.task !== a.task) return i
          if (a.task === 'fibl' && i.exerciseId !== a.exerciseId) return i
          done = true
          return { ...i, attemptId: a.id }
        })
        await db.plans.put({ ...plan, items, updatedAt: now, dirty: 1 })
      }
    }
  })
}

/** Map a WFD sentence result back to token positions so each wrong word has its own audio snippet. */
function wfdWords(item: ListeningAttempt['items'][number], ex: Exercise) {
  const from = Number(item.ref.split(':').pop())
  return item.kinds.map((kind, k) => ({
    kind,
    index: Number.isFinite(from) ? from + k : -1,
    expected: ex.tokens[from + k]?.spokenText ?? '',
    typed: item.typedWords?.[k] ?? '',
  }))
}

export async function recentListening(task?: ListeningAttempt['task'], limit = 200): Promise<ListeningAttempt[]> {
  const all = await db.listening.orderBy('completedAt').reverse().filter((a) => !a.deleted && (!task || a.task === task)).limit(limit).toArray()
  return all
}

/** Add the FIB-L / WFD items to a plan made before those tasks existed. */
export async function addListeningToPlan(planId: string, exercises: readonly Exercise[]): Promise<void> {
  const plan = await db.plans.get(planId)
  if (!plan || plan.items.some((i) => i.task === 'fibl' || i.task === 'wfd')) return
  const fresh = buildDailyPlan({ date: plan.date, exercises, attempts: [], mistakes: [], speed: 1, now: Date.now(), listening: await listeningInput(exercises) })
  const have = new Set(plan.items.map((i) => i.exerciseId))
  const extra = fresh.items.filter((i) => i.task === 'wfd' || (i.task === 'fibl' && !have.has(i.exerciseId)))
  const reviewAt = plan.items.findIndex((i) => i.block === 'review')
  const items = reviewAt < 0 ? [...plan.items, ...extra] : [...plan.items.slice(0, reviewAt), ...extra, ...plan.items.slice(reviewAt)]
  await db.plans.put({ ...plan, items, updatedAt: Date.now(), dirty: 1 })
}

/** After finishing today's plan: append a few more exercises chosen for current weaknesses. */
export async function extendPlan(planId: string, exercises: readonly Exercise[], speed: number, count = 3): Promise<void> {
  const plan = await db.plans.get(planId)
  if (!plan) return
  const fresh = buildDailyPlan({ date: plan.date, exercises, attempts: await recentAttempts(60), mistakes: await liveMistakes(), speed, now: Date.now(), listening: await listeningInput(exercises) })
  const have = new Set(plan.items.map((i) => i.exerciseId))
  const extra = fresh.items.filter((i) => (i.block === 'drill' || i.block === 'realistic') && !have.has(i.exerciseId)).slice(0, count)
  await db.plans.put({ ...plan, items: [...plan.items, ...extra], updatedAt: Date.now(), dirty: 1 })
}

// ── My words ────────────────────────────────────────────────────────

/**
 * Dictionary lookup (free dictionaryapi.dev — only the word itself is sent). Results, including
 * "not found", are cached locally so repeat lookups and offline use work.
 */
export async function lookupWord(raw: string): Promise<DictionaryResult | null | 'offline'> {
  const word = headword(raw)
  if (!word) return null
  const key = `dict:${word}`
  const cached = await getMeta<DictionaryResult | null>(key)
  if (cached) return cached
  const get = async (url: string, ms: number) => {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), ms)
    try {
      const res = await fetch(url, { signal: ctl.signal })
      return res.ok ? await res.json() : res.status === 404 ? null : undefined
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }
  // Both sources in parallel (only the word is sent): the Free Dictionary API has pronunciations
  // but is sometimes slow; Wiktionary is the fallback.
  const [primary, wikt] = await Promise.all([
    get(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, 3000),
    get(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`, 6000),
  ])
  const result = (primary ? parseDictionary(primary) : null) ?? (wikt ? parseWiktionary(word, wikt) : null)
  const reachable = primary !== undefined || wikt !== undefined
  if (!reachable) return 'offline'
  if (result) await setMeta(key, result)
  return result
}

/** Fill in definitions for words saved while offline (called from the word list). */
export async function backfillDefinitions(limit = 5): Promise<void> {
  const missing = (await db.vocab.toArray()).filter((v) => !v.deleted && v.meanings.length === 0).slice(0, limit)
  for (const v of missing) {
    const r = await lookupWord(v.id)
    if (r === 'offline') return
    if (r) await db.vocab.update(v.id, { meanings: r.meanings, phonetic: r.phonetic, audioUrl: r.audioUrl, updatedAt: Date.now(), dirty: 1 })
  }
}

export async function saveWord(raw: string, extra: Partial<VocabEntry>, dict: DictionaryResult | null): Promise<void> {
  const id = headword(raw)
  const now = Date.now()
  const existing = await db.vocab.get(id)
  const entry: VocabEntry = {
    id,
    word: dict?.word || id,
    phonetic: dict?.phonetic,
    audioUrl: dict?.audioUrl,
    meanings: dict?.meanings ?? [],
    status: 'learning',
    addedAt: now,
    ...(existing && !existing.deleted ? { addedAt: existing.addedAt, status: existing.status, knownAt: existing.knownAt } : {}),
    ...extra,
    updatedAt: now,
  }
  await db.vocab.put({ ...entry, dirty: 1, deleted: undefined })
}

export async function setWordStatus(id: string, status: VocabEntry['status']): Promise<void> {
  const now = Date.now()
  await db.vocab.update(id, { status, knownAt: status === 'known' ? now : undefined, updatedAt: now, dirty: 1 })
}

export async function removeWord(id: string): Promise<void> {
  await db.vocab.update(id, { deleted: 1, updatedAt: Date.now(), dirty: 1 })
}

export async function liveVocab(): Promise<VocabEntry[]> {
  return (await db.vocab.toArray()).filter((v) => !v.deleted)
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
  vocab?: unknown[]
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
    vocab: await db.vocab.toArray(),
  }
  return new Blob([JSON.stringify(data)], { type: 'application/json' })
}

/** Merge a backup: newer `updatedAt` wins per record; nothing local is lost. */
export async function importBackup(file: File): Promise<number> {
  const data = JSON.parse(await file.text()) as Backup
  if (data.app !== 'hiw-trainer') throw new Error('not-a-backup')
  let n = 0
  await db.transaction('rw', [db.attempts, db.mistakes, db.plans, db.customExercises, db.settings, db.vocab], async () => {
    for (const name of ['attempts', 'mistakes', 'plans', 'customExercises', 'settings', 'vocab'] as const) {
      const table = db[name] as unknown as import('dexie').Table<{ id: string; updatedAt: number }, string>
      for (const row of (data[name] ?? []) as { id: string; updatedAt: number }[]) {
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
