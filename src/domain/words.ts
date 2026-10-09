/**
 * PTE word games: the study list (public/content/words.json, built by scripts/build_words.py), per-word
 * progress kept on "My words" entries, and how a short round is put together. Pure — no storage, no React.
 *
 * A word moves up one level per right answer and is asked again after a growing wait (10 min → 1 day →
 * 3 days → 7 days → 3 weeks). It counts as learned at level 4, i.e. after passing a 3-day check.
 * A miss steps it back a little and brings it back later in the same round — nothing is "lost".
 */
import type { Exercise, Token, VocabEntry } from './types'

export interface StudyWord {
  w: string
  /** Main part of speech ("n.", "v.", "adj."…). */
  p: string
  /** Traditional Chinese meaning(s). */
  zh: string
  /** Short English definition. */
  en: string
  ipa: string
  /** 50-word pack, most useful first. */
  pack: number
  /** Look-alikes the way HIW swaps words: same ending (attention/retention) or same start (valid/vital). */
  alike?: string[]
  /** A passage in the library that says it: exercise id + token index. */
  ex?: [string, number]
}

export interface WordData {
  words: StudyWord[]
  /** Chinese meaning of other passage words; "=lemma" points to a study word (civilizations → civilization). */
  gloss: Record<string, string>
}

const MIN = 60_000
const DAY = 24 * 60 * MIN

/** Wait before the next question at each level. */
export const WORD_INTERVALS = [0, 10 * MIN, DAY, 3 * DAY, 7 * DAY, 21 * DAY] as const
export const LEARNED = 4
const TOP = WORD_INTERVALS.length - 1
/** Words sorted as "already know it" come back only for an occasional check. */
const KNEW_RECHECK = 60 * DAY

export const ROUND_SIZE = 10
export const MAX_NEW = 4

export type WordProgress = Pick<VocabEntry, 'id' | 'level' | 'dueAt' | 'knewAlready' | 'source' | 'status'>

export function isLearned(p: WordProgress | undefined): boolean {
  return !!p && !p.knewAlready && (p.level ?? 0) >= LEARNED
}

/** Started in the games and not learned yet. */
export function isLearning(p: WordProgress | undefined): boolean {
  return !!p && p.level !== undefined && !p.knewAlready && p.level < LEARNED
}

export function isDueWord(p: WordProgress | undefined, now: number): boolean {
  return !!p && p.level !== undefined && p.dueAt !== undefined && p.dueAt <= now
}

/** Next level and due time after an answer. */
export function answerWord(p: Pick<VocabEntry, 'level'> | undefined, correct: boolean, now: number): { level: number; dueAt: number } {
  const level = p?.level ?? 0
  if (correct) {
    const next = Math.min(TOP, level + 1)
    return { level: next, dueAt: now + WORD_INTERVALS[next] }
  }
  // A miss: a small step back (never below "just met"), asked again soon.
  const next = Math.max(0, Math.min(level - 1, 2))
  return { level: next, dueAt: now + WORD_INTERVALS[1] }
}

/** Progress for words she says she already knows. */
export function knewAlready(now: number): { level: number; dueAt: number; knewAlready: true } {
  return { level: TOP, dueAt: now + KNEW_RECHECK, knewAlready: true }
}

export interface PackStats {
  pack: number
  total: number
  learned: number
  knew: number
  learning: number
}

export function packStats(words: readonly StudyWord[], progress: ReadonlyMap<string, WordProgress>): PackStats[] {
  const out = new Map<number, PackStats>()
  for (const w of words) {
    const s = out.get(w.pack) ?? { pack: w.pack, total: 0, learned: 0, knew: 0, learning: 0 }
    const p = progress.get(w.w)
    s.total++
    if (p?.knewAlready) s.knew++
    else if (isLearned(p)) s.learned++
    else if (isLearning(p)) s.learning++
    out.set(w.pack, s)
  }
  return [...out.values()].sort((a, b) => a.pack - b.pack)
}

/** The first pack with words she hasn't met yet. */
export function currentPack(words: readonly StudyWord[], progress: ReadonlyMap<string, WordProgress>): number {
  return words.find((w) => progress.get(w.w)?.level === undefined)?.pack ?? words[words.length - 1]?.pack ?? 1
}

/** Words not met yet, in list order (optionally from one pack). */
export function unmet(words: readonly StudyWord[], progress: ReadonlyMap<string, WordProgress>, pack?: number): StudyWord[] {
  return words.filter((w) => (pack === undefined || w.pack === pack) && progress.get(w.w)?.level === undefined)
}

export interface RoundPlan {
  /** Words to review, most overdue first. */
  review: StudyWord[]
  /** New words to meet. */
  fresh: StudyWord[]
}

/**
 * One round: due words first (the most overdue), topped up with new words from the current pack
 * (or the chosen one) — at most MAX_NEW, at least 2 so every round brings something new.
 */
export function planRound(words: readonly StudyWord[], progress: ReadonlyMap<string, WordProgress>, now: number, pack?: number): RoundPlan {
  const byWord = new Map(words.map((w) => [w.w, w]))
  const due = [...progress.values()]
    .filter((p) => isDueWord(p, now) && byWord.has(p.id) && (pack === undefined || byWord.get(p.id)!.pack === pack))
    .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0))
    .map((p) => byWord.get(p.id)!)
  const newCount = Math.max(2, Math.min(MAX_NEW, ROUND_SIZE - due.length))
  const review = due.slice(0, ROUND_SIZE - newCount)
  const fresh = unmet(words, progress, pack ?? currentPack(words, progress)).slice(0, newCount)
  // A finished pack: take the next new words from wherever they are.
  if (fresh.length < newCount && pack === undefined) fresh.push(...unmet(words, progress).filter((w) => !fresh.includes(w)).slice(0, newCount - fresh.length))
  return { review, fresh }
}

// ── Questions ────────────────────────────────────────────────────────

export type QuestionKind = 'meet' | 'meaning' | 'listen' | 'reverse' | 'context' | 'spell'

export interface Question {
  kind: QuestionKind
  word: StudyWord
  /** Choices (English words, or Chinese meanings for 'meaning'); the answer is among them. */
  options: string[]
  answer: string
}

/** Deterministic pseudo-random numbers (mulberry32), so rounds are testable. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function shuffle<T>(xs: readonly T[], rand: () => number): T[] {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * Which kind of question suits a word at this level: meaning first, then hearing it among
 * look-alikes (the HIW skill), then producing it (reverse, a real sentence, spelling).
 */
export function questionKind(word: StudyWord, level: number, rand: () => number): Exclude<QuestionKind, 'meet'> {
  const lookalikes = (word.alike?.length ?? 0) >= 2
  const options: Exclude<QuestionKind, 'meet'>[] =
    level <= 0 ? ['meaning'] : level === 1 ? ['listen', 'meaning'] : level === 2 ? ['reverse', 'context', 'listen'] : ['spell', 'context', 'listen', 'reverse']
  const usable = options.filter((k) => (k === 'listen' || k === 'reverse' ? lookalikes : k === 'context' ? !!word.ex : true))
  if (!usable.length) return 'meaning'
  // The first option is the main one for the level; the others add variety.
  return rand() < 0.6 ? usable[0] : usable[Math.floor(rand() * usable.length)]
}

/** Three other meanings of the same part of speech from nearby packs. */
function meaningOptions(word: StudyWord, words: readonly StudyWord[], rand: () => number): string[] {
  const near = words.filter((w) => w.w !== word.w && w.zh !== word.zh && Math.abs(w.pack - word.pack) <= 3)
  const same = near.filter((w) => w.p === word.p)
  const pool = shuffle(same.length >= 3 ? same : near, rand)
  return pool.slice(0, 3).map((w) => w.zh)
}

/** The word and up to three look-alikes (other study words of similar shape when it has few). */
function spellingOptions(word: StudyWord, words: readonly StudyWord[], rand: () => number): string[] {
  const own = (word.alike ?? []).filter((a) => a !== word.w).slice(0, 3)
  if (own.length < 3) {
    const similar = words.filter(
      (w) => w.w !== word.w && !own.includes(w.w) && w.w[0] === word.w[0] && Math.abs(w.w.length - word.w.length) <= 2,
    )
    own.push(...shuffle(similar, rand).slice(0, 3 - own.length).map((w) => w.w))
  }
  return own
}

export function makeQuestion(kind: QuestionKind, word: StudyWord, words: readonly StudyWord[], rand: () => number): Question {
  if (kind === 'meet' || kind === 'spell') return { kind, word, options: [], answer: word.w }
  if (kind === 'meaning') return { kind, word, options: shuffle([word.zh, ...meaningOptions(word, words, rand)], rand), answer: word.zh }
  return { kind, word, options: shuffle([word.w, ...spellingOptions(word, words, rand)], rand), answer: word.w }
}

/**
 * The questions of a round: each new word is met first and asked later; reviews are mixed in between
 * so a new word's question isn't straight after its card.
 */
export function buildQuestions(plan: RoundPlan, progress: ReadonlyMap<string, WordProgress>, words: readonly StudyWord[], rand: () => number): Question[] {
  const reviews = plan.review.map((w) => makeQuestion(questionKind(w, progress.get(w.w)?.level ?? 0, rand), w, words, rand))
  const out: Question[] = []
  const pendingNew: Question[] = []
  let r = 0
  for (const w of plan.fresh) {
    out.push(makeQuestion('meet', w, words, rand))
    if (r < reviews.length) out.push(reviews[r++])
    pendingNew.push(makeQuestion('meaning', w, words, rand))
    if (pendingNew.length > 1) out.push(pendingNew.shift()!)
  }
  while (r < reviews.length || pendingNew.length) {
    if (r < reviews.length) out.push(reviews[r++])
    if (pendingNew.length) out.push(pendingNew.shift()!)
  }
  return out
}

/** A missed word comes back once, later in the round, as an easier question. */
export function retryQuestion(q: Question, words: readonly StudyWord[], rand: () => number): Question {
  return makeQuestion(q.kind === 'spell' || q.kind === 'context' ? 'listen' : 'meaning', q.word, words, rand)
}

// ── Real sentences ───────────────────────────────────────────────────

export interface Sentence {
  before: string
  word: string
  after: string
  startMs: number
  endMs: number
}

const show = (t: Token) => `${t.leading}${t.spokenText}${t.trailing}`

/** The spoken sentence around a token (at most ~25 words), with the word cut out. */
export function sentenceAround(ex: Exercise, index: number): Sentence | null {
  const toks = ex.tokens
  if (!toks[index]) return null
  let from = index
  while (from > 0 && from > index - 14 && !/[.!?]/.test(toks[from - 1].trailing)) from--
  let to = index
  while (to < toks.length - 1 && to < index + 14 && !/[.!?]/.test(toks[to].trailing)) to++
  const t = toks[index]
  return {
    before: toks.slice(from, index).map(show).join(' ') + (from < index ? ' ' : '') + t.leading,
    word: t.spokenText,
    after: t.trailing + (index < to ? ' ' : '') + toks.slice(index + 1, to + 1).map(show).join(' '),
    startMs: Math.max(0, toks[from].startMs - 150),
    endMs: toks[to].endMs + 250,
  }
}

/** Chinese meaning for any word: the study list first, then the passage gloss (following "=lemma"). */
export function glossOf(data: WordData, byWord: ReadonlyMap<string, StudyWord>, word: string): { zh: string; lemma?: string } | null {
  const w = word.toLowerCase()
  const direct = byWord.get(w)
  if (direct) return { zh: direct.zh }
  const g = data.gloss[w]
  if (!g) return null
  if (g.startsWith('=')) {
    const lemma = g.slice(1)
    const s = byWord.get(lemma)
    return s ? { zh: s.zh, lemma } : null
  }
  return { zh: g }
}
