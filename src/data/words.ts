import { useEffect, useState } from 'react'
import { answerWord, knewAlready, LEARNED, type StudyWord, type WordData, type WordProgress } from '../domain/words'
import type { ListeningAttempt, VocabEntry } from '../domain/types'
import { db, newId } from './db'

let data: Promise<WordData> | null = null

/** The PTE word list (≈850 KB, precached with the app). Loaded once. */
export function loadWordData(): Promise<WordData> {
  data ??= fetch('/content/words.json')
    .then((r) => {
      if (!r.ok) throw new Error(String(r.status))
      return r.json() as Promise<WordData>
    })
    .catch((e: unknown) => {
      data = null
      throw e
    })
  return data
}

export interface Words {
  data: WordData
  byWord: Map<string, StudyWord>
}

let indexed: Words | null = null

/** The word list with a lookup map; null until loaded (or if it couldn't be). */
export function useWords(): Words | null {
  const [w, setW] = useState<Words | null>(indexed)
  useEffect(() => {
    if (indexed) return
    let live = true
    loadWordData().then(
      (d) => {
        indexed = { data: d, byWord: new Map(d.words.map((x) => [x.w, x])) }
        if (live) setW(indexed)
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [])
  return w
}

/** Recorded pronunciation of a study word (generated offline; the device voice is the fallback). */
export function wordAudioUrl(word: string): string {
  return `/audio/words/${encodeURIComponent(word)}.mp3`
}

/** Word-game progress of every word she has met, by word. */
export async function wordProgress(): Promise<Map<string, VocabEntry>> {
  const rows = await db.vocab.toArray()
  return new Map(rows.filter((r) => !r.deleted && r.level !== undefined).map((r) => [r.id, r]))
}

function fresh(w: StudyWord, now: number): VocabEntry {
  return {
    id: w.w,
    word: w.w,
    phonetic: w.ipa ? `/${w.ipa}/` : undefined,
    meanings: w.en ? [{ partOfSpeech: w.p.replace('.', ''), definition: w.en }] : [],
    zh: w.zh,
    status: 'learning',
    addedAt: now,
    source: 'game',
    updatedAt: now,
  }
}

/** Apply one change to a word's entry, creating it (as a game word) when she hasn't met it before. */
async function updateWord(w: StudyWord, now: number, change: (cur: VocabEntry) => Partial<VocabEntry>): Promise<void> {
  const row = await db.vocab.get(w.w)
  const cur: VocabEntry = row && !row.deleted ? { ...row, zh: row.zh ?? w.zh } : fresh(w, now)
  const next = { ...cur, ...change(cur), updatedAt: now }
  if (next.status === 'learning' && (next.level ?? 0) >= LEARNED) Object.assign(next, { status: 'known', knownAt: now })
  await db.vocab.put({ ...next, dirty: 1, deleted: undefined })
}

/** She has seen the word's card: it joins her words at level 0, asked later in the round. */
export function meetWord(w: StudyWord, now = Date.now()): Promise<void> {
  return updateWord(w, now, (cur) => (cur.level === undefined ? { level: 0, dueAt: now } : {}))
}

export function recordWordAnswer(w: StudyWord, correct: boolean, now = Date.now()): Promise<void> {
  return updateWord(w, now, (cur) => ({ ...answerWord(cur, correct, now), knewAlready: undefined }))
}

/** "I already know these": skipped in rounds, not counted as learned. */
export async function markWordsKnown(ws: readonly StudyWord[], now = Date.now()): Promise<void> {
  await db.transaction('rw', db.vocab, async () => {
    for (const w of ws) await updateWord(w, now, () => ({ ...knewAlready(now), status: 'known', knownAt: now }))
  })
}

/** Put a sorted-out word back into the games. */
export function unmarkWordKnown(w: StudyWord, now = Date.now()): Promise<void> {
  return updateWord(w, now, () => ({ level: 0, dueAt: now, knewAlready: undefined, status: 'learning', knownAt: undefined }))
}

export interface WordAnswer {
  word: string
  typed: string
  correct: boolean
}

/** A finished round, kept with the FIB-L/WFD results so it counts toward minutes, days and points. */
export async function saveWordRound(answers: readonly WordAnswer[], startedAt: number, now = Date.now()): Promise<ListeningAttempt> {
  const a: ListeningAttempt = {
    id: newId(),
    task: 'words',
    exerciseId: 'words',
    mode: 'practice',
    items: answers.map((x) => ({
      ref: x.word,
      exerciseId: 'words',
      expected: x.word,
      typed: x.typed,
      correct: x.correct ? 1 : 0,
      total: 1,
      kinds: [x.correct ? 'correct' : 'wrong'],
    })),
    correct: answers.filter((x) => x.correct).length,
    total: answers.length,
    startedAt,
    completedAt: now,
    updatedAt: now,
  }
  await db.listening.put({ ...a, dirty: 1 })
  return a
}

export type { WordProgress }
