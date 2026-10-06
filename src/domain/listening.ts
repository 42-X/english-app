/**
 * FIB-L (Listening: Fill in the Blanks) and WFD (Write From Dictation).
 * Both reuse the human-voice passages and their word timings. PTE scoring: one point per
 * correctly spelled word, no negative marking. British and American spellings both count.
 */
import type { Coaching } from './coaching'
import type { Exercise, ListeningAttempt, Token } from './types'

// ── Answer comparison ─────────────────────────────────────────────────────

export function normAnswer(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/^[^a-z0-9]+|[^a-z0-9%]+$/g, '')
}

/**
 * Map British spellings to American so either is accepted (colour/color, organise/organize,
 * centre/center, travelled/traveled…). Rules are narrow on purpose: a loose rule would accept
 * real mistakes ("for" for "four", "filed" for "filled").
 */
function toUS(w: string): string {
  return w
    .replace(/^([a-z]{3,})our(s|ed|ing|ite|ites|able)?$/, '$1or$2') // colour, behaviour, favourite (not four/hour/flour)
    .replace(/^([a-z]{3,})is(e|es|ed|ing|ation|ations)$/, '$1iz$2') // organise, realisation
    .replace(/^([a-z]{2,})ys(e|es|ed|ing)$/, '$1yz$2') // analyse, paralysed
    .replace(/^([a-z]{2,})tre(s?)$/, '$1ter$2') // centre, metre, fibre
    .replace(/^([a-z]{3,})ogue(s?)$/, '$1og$2') // catalogue, dialogue
    .replace(/^(defen|offen|licen|preten)ce$/, '$1se')
    .replace(/^(travel|cancel|model|label|level|fuel|signal|total|equal|channel|counsel|marvel|jewel|tunnel|quarrel|rival)l(ed|ing|er|ers)$/, '$1$2')
    .replace(/^an(a)?emi/, 'anemi')
    .replace(/^paediatric/, 'pediatric')
}

export function sameWord(a: string, b: string): boolean {
  const x = normAnswer(a)
  const y = normAnswer(b)
  return x === y || (x.length > 3 && toUS(x) === toUS(y))
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[b.length]
}

const ENDINGS = /(ies|es|s|ed|d|ing|ly|er|est|al|ment|ion|ions)$/

function stem(w: string): string {
  return w.length > 4 ? w.replace(ENDINGS, '') : w
}

/**
 * Why an answer is wrong:
 *  - ending: right word, wrong ending (plural, tense, -ly…) — heard the word, missed the end
 *  - spelling: close misspelling of the right word — heard it, couldn't spell it
 *  - wrong: a different word — didn't hear it
 *  - blank: nothing typed
 */
export type AnswerKind = 'correct' | 'ending' | 'spelling' | 'wrong' | 'blank'

/** Short grammatical words: typing one of these for another word is a different word, not a misspelling. */
const FUNCTION_WORDS = new Set(
  'a an the and or but nor so yet of in on at to for by as is are was were be been it its this that these those they them their there he she we you his her our i if not no do does did can may has had have any some all'.split(' '),
)

export function classifyAnswer(expected: string, typed: string): AnswerKind {
  const e = normAnswer(expected)
  const t = normAnswer(typed)
  if (!t) return 'blank'
  if (sameWord(e, t)) return 'correct'
  // "this" for "these", "the" for "they": a different word, however close the letters look.
  if (FUNCTION_WORDS.has(t) || FUNCTION_WORDS.has(e) || e.length < 4) return 'wrong'
  if (stem(e) === stem(t) || (e.startsWith(t) && e.length - t.length <= 3) || (t.startsWith(e) && t.length - e.length <= 3)) return 'ending'
  const d = levenshtein(e, t)
  if (e[0] === t[0] ? d <= Math.max(1, Math.round(e.length * 0.34)) : d <= 1) return 'spelling'
  return 'wrong'
}

// ── FIB-L: choosing the blanks ───────────────────────────────────────────

const STOP: Set<string> = new Set(
  'about above after again against also although among another around because been before being below between both cannot could does doing down during each either even ever every from further have having here however into itself just least less many might more most much must neither never only other others over same should since some still such than that their theirs them themselves then there therefore these they this those though through thus toward towards under until upon very were what when where whether which while whom whose will with within without would your yours'.split(' '),
)

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/** How well a word works as a blank: exam blanks favour content words with endings worth hearing. */
function blankScore(tokens: readonly Token[], i: number): number {
  const t = tokens[i]
  const w = t.spokenText
  // Plain words only: no hyphens/apostrophes (unfair to type), no very long technical terms.
  if (!/^[A-Za-z][a-z]*$/.test(w) || w.length < 4 || w.length > 13 || STOP.has(w.toLowerCase())) return 0
  const prev = tokens[i - 1]
  const sentenceStart = !prev || /[.!?]/.test(prev.trailing)
  if (/^[A-Z]/.test(w) && !sentenceStart) return 0 // proper nouns: unfair to spell
  let s = 1 + Math.min(w.length, 9) / 6
  if (/(s|ed|ing|ly|tion|sion|ment|ance|ence|ity|ive|al)$/.test(w)) s += 1 // endings are what candidates miss
  if (w.length > 10) s -= 0.8 // prefer everyday academic words over jargon
  return s
}

/** Blank positions for a passage: ~1 per 14 words (5–9), spread out, never adjacent. Deterministic. */
export function fiblBlanks(ex: Exercise): number[] {
  const n = ex.tokens.length
  const k = Math.max(5, Math.min(9, Math.round(n / 14)))
  const seg = n / k
  const seed = hash(ex.id)
  const out: number[] = []
  for (let s = 0; s < k; s++) {
    const from = Math.max(3, Math.floor(s * seg))
    const to = Math.min(n, Math.floor((s + 1) * seg))
    let best = -1
    let bestScore = 0
    for (let i = from; i < to; i++) {
      if (out.length && i - out[out.length - 1] < 4) continue
      if (out.some((o) => ex.tokens[o].spokenText.toLowerCase() === ex.tokens[i].spokenText.toLowerCase())) continue
      const sc = blankScore(ex.tokens, i)
      // Tiny deterministic jitter so equal-scoring words don't always pick the first.
      const j = sc + ((seed >> (i % 24)) & 7) / 40
      if (sc > 0 && j > bestScore) {
        best = i
        bestScore = j
      }
    }
    if (best >= 0) out.push(best)
  }
  return out
}

/**
 * Is a wrongly typed / missed word worth a spelling-review card? Heard-but-misspelled words always
 * are; words not caught at all only when they're substantial (not "the", "of", "and"…).
 */
export function worthReviewing(word: string, kind: AnswerKind): boolean {
  if (kind === 'correct') return false
  if (kind === 'spelling' || kind === 'ending') return true
  const w = normAnswer(word)
  return w.length >= 5 && !STOP.has(w) && !/\d/.test(w)
}

/** At most this many new spelling cards from one WFD set, so the bank stays useful. */
export const MAX_NEW_SPELLING_PER_SET = 8

// ── WFD: dictation sentences ─────────────────────────────────────────────

export interface WfdSentence {
  /** `${exerciseId}:${first token index}` */
  id: string
  exerciseId: string
  from: number
  to: number
  /** Media window to play, clamped so neighbouring words don't leak in. */
  startMs: number
  endMs: number
  text: string
  words: string[]
}

/** Sentences of 8–15 words and ≤ 6.5 s, without digits (dictated numbers are ambiguous to type). */
export function extractWfd(exercises: readonly Exercise[]): WfdSentence[] {
  const out: WfdSentence[] = []
  for (const ex of exercises) {
    if (!ex.tags.includes('human-audio') || ex.archived || ex.custom) continue
    const toks = ex.tokens
    let start = 0
    for (let i = 0; i < toks.length; i++) {
      if (!/[.!?]/.test(toks[i].trailing) && i < toks.length - 1) continue
      const span = toks.slice(start, i + 1)
      const prevEnd = start > 0 ? toks[start - 1].endMs : 0
      const nextStart = i + 1 < toks.length ? toks[i + 1].startMs : ex.durationMs
      const startMs = Math.max(prevEnd, span[0].startMs - 150)
      const endMs = Math.min(nextStart, span[span.length - 1].endMs + 200)
      const ok =
        span.length >= 8 &&
        span.length <= 15 &&
        start > 0 && // a sentence that begins the clip may be clipped at the start
        endMs - startMs <= 6500 &&
        span.every((t) => !/\d/.test(t.spokenText) && t.spokenText.length < 18)
      if (ok) {
        const words = span.map((t) => t.spokenText)
        out.push({
          id: `${ex.id}:${start}`,
          exerciseId: ex.id,
          from: start,
          to: i,
          startMs,
          endMs,
          text: span.map((t) => `${t.leading}${t.spokenText}${t.trailing}`).join(' '),
          words,
        })
      }
      start = i + 1
    }
  }
  return out
}

export interface WfdWordResult {
  expected: string
  kind: AnswerKind
  /** What she typed for this word, if matched to something. */
  typed?: string
}

/**
 * PTE-style WFD scoring: one point per correctly spelled word of the sentence, order-insensitive.
 * Unmatched typed words are then paired (in order) with missed words to explain the error.
 */
export function scoreWfd(expected: string[], typedText: string): { correct: number; total: number; words: WfdWordResult[]; extra: string[] } {
  const typed = typedText.split(/\s+/).map(normAnswer).filter(Boolean)
  const used = new Array(typed.length).fill(false)
  const words: WfdWordResult[] = expected.map((e) => {
    const j = typed.findIndex((t, k) => !used[k] && sameWord(e, t))
    if (j >= 0) {
      used[j] = true
      return { expected: e, kind: 'correct' as AnswerKind, typed: typed[j] }
    }
    return { expected: e, kind: 'blank' as AnswerKind }
  })
  // Explain misses with the nearest leftover typed word.
  for (const w of words) {
    if (w.kind !== 'blank') continue
    let best = -1
    let bestKind: AnswerKind = 'wrong'
    for (let k = 0; k < typed.length; k++) {
      if (used[k]) continue
      const kind = classifyAnswer(w.expected, typed[k])
      if (kind === 'ending' || kind === 'spelling') {
        best = k
        bestKind = kind
        break
      }
    }
    if (best >= 0) {
      used[best] = true
      w.kind = bestKind
      w.typed = typed[best]
    }
  }
  return {
    correct: words.filter((w) => w.kind === 'correct').length,
    total: expected.length,
    words,
    extra: typed.filter((_, k) => !used[k]),
  }
}

// ── Feedback ──────────────────────────────────────────────────────────────


export type KindCounts = Record<AnswerKind, number>

export function kindCounts(a: Pick<ListeningAttempt, 'items'>): KindCounts {
  const c: KindCounts = { correct: 0, ending: 0, spelling: 0, wrong: 0, blank: 0 }
  for (const it of a.items) for (const k of it.kinds) c[k]++
  return c
}

/** Deterministic coaching for one FIB-L / WFD result, biggest point-loser first. */
export function listeningCoaching(a: ListeningAttempt): Coaching[] {
  const c = kindCounts(a)
  const out: Coaching[] = [
    { key: 'lst.score', params: { correct: a.correct, total: a.total, pct: Math.round((a.correct / Math.max(1, a.total)) * 100) }, tone: a.correct / Math.max(1, a.total) >= 0.8 ? 'good' : 'info' },
  ]
  const losses: [AnswerKind, number][] = (['ending', 'spelling', 'wrong', 'blank'] as const).map((k) => [k, c[k]] as [AnswerKind, number]).filter(([, n]) => n > 0)
  losses.sort((x, y) => y[1] - x[1])
  for (const [k, n] of losses) out.push({ key: `lst.${k}${k === 'blank' ? `.${a.task}` : ''}`, params: { n }, tone: 'warn' })
  if (a.task === 'wfd' && a.mode === 'practice') {
    const replays = a.items.reduce((n, it) => n + (it.replays ?? 0), 0)
    if (replays > 0) out.push({ key: 'lst.replays', params: { n: replays }, tone: 'info' })
  }
  return out
}

export interface TaskStats {
  attempts: number
  correct: number
  total: number
  accuracy: number | null
}

export interface ListeningStats {
  fibl: TaskStats
  wfd: TaskStats
  kinds: KindCounts
  /** Words most often missed or misspelled, most frequent first. */
  topWords: { word: string; count: number }[]
}

export function listeningStats(attempts: readonly ListeningAttempt[]): ListeningStats {
  const task = (k: ListeningAttempt['task']): TaskStats => {
    const xs = attempts.filter((a) => a.task === k)
    const correct = xs.reduce((n, a) => n + a.correct, 0)
    const total = xs.reduce((n, a) => n + a.total, 0)
    return { attempts: xs.length, correct, total, accuracy: total ? correct / total : null }
  }
  const kinds: KindCounts = { correct: 0, ending: 0, spelling: 0, wrong: 0, blank: 0 }
  const words = new Map<string, number>()
  for (const a of attempts) {
    for (const it of a.items) {
      const expected = a.task === 'fibl' ? [it.expected] : it.expected.split(/\s+/).map(normAnswer)
      it.kinds.forEach((k, i) => {
        kinds[k]++
        if (k !== 'correct') {
          const w = normAnswer(expected[i] ?? '')
          if (w) words.set(w, (words.get(w) ?? 0) + 1)
        }
      })
    }
  }
  return {
    fibl: task('fibl'),
    wfd: task('wfd'),
    kinds,
    topWords: [...words.entries()].map(([word, count]) => ({ word, count })).sort((a, b) => b.count - a.count || a.word.localeCompare(b.word)).slice(0, 12),
  }
}
