import type { Token, TrapCategory } from './types'

export interface RawWord {
  core: string
  leading: string
  trailing: string
  breakAfter: boolean
}

const LEAD = /^[^\p{L}\p{N}]+/u
const TRAIL = /[^\p{L}\p{N}%]+$/u

/** Split text into selectable words, keeping punctuation separate from the word itself. */
export function splitWords(text: string): RawWord[] {
  const out: RawWord[] = []
  const paragraphs = text.trim().split(/\n\s*\n/)
  paragraphs.forEach((para, pi) => {
    for (const chunk of para.split(/\s+/).filter(Boolean)) {
      const leading = chunk.match(LEAD)?.[0] ?? ''
      const rest = chunk.slice(leading.length)
      const trailing = rest.match(TRAIL)?.[0] ?? ''
      const core = rest.slice(0, rest.length - trailing.length)
      if (!core) {
        // Stand-alone punctuation (e.g. a dash) attaches to the previous word.
        const prev = out[out.length - 1]
        if (prev) prev.trailing += ` ${chunk}`
        continue
      }
      out.push({ core, leading, trailing, breakAfter: false })
    }
    const last = out[out.length - 1]
    if (last && pi < paragraphs.length - 1) last.breakAfter = true
  })
  return out
}

export function normalizeWord(w: string): string {
  return w.toLowerCase().replace(/[’']/g, "'").replace(/[^\p{L}\p{N}'%-]/gu, '')
}

const FUNCTION_WORDS = new Set(
  'a an the this that these those some any each every no his her its their our your my has have had is are was were be been being do does did can could will would shall should may might must and or but nor so yet not'.split(' '),
)
const PREPOSITIONS = new Set(
  'in on at by for from to into onto of off over under with within without about above below across after before behind beside between beyond during through toward towards upon among against along around'.split(' '),
)
const NUMBER_WORDS = new Set(
  'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion half quarter third first second percent'.split(' '),
)
const MONTHS = new Set('january february march april may june july august september october november december'.split(' '))

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

function commonPrefix(a: string, b: string): number {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

function commonSuffix(a: string, b: string): number {
  let i = 0
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++
  return i
}

/** Heuristic trap category for a displayed/spoken pair. The learner/admin can correct it. */
export function guessTrapCategory(display: string, spoken: string): TrapCategory {
  const d = normalizeWord(display)
  const s = normalizeWord(spoken)
  const isNum = (w: string) => /\d/.test(w)
  if (isNum(d) && isNum(s)) return /^(1[5-9]|20)\d\d$/.test(d) && /^(1[5-9]|20)\d\d$/.test(s) ? 'date' : 'number'
  if (MONTHS.has(d) && MONTHS.has(s)) return 'date'
  if ((isNum(d) || NUMBER_WORDS.has(d)) && (isNum(s) || NUMBER_WORDS.has(s))) return 'number'
  const strip = (w: string, suf: string) => (w.endsWith(suf) ? w.slice(0, -suf.length) : w)
  if (strip(d, 's') === s || strip(s, 's') === d || strip(d, 'es') === s || strip(s, 'es') === d) return 'singular-plural'
  if (d.endsWith('ed') !== s.endsWith('ed') && commonPrefix(d, s) >= Math.min(d.length, s.length) - 2) return 'ed-ending'
  if (d.endsWith('ing') !== s.endsWith('ing') && commonPrefix(d, s) >= 3) return 'ing-ending'
  if (PREPOSITIONS.has(d) && PREPOSITIONS.has(s)) return 'preposition'
  if (FUNCTION_WORDS.has(d) || FUNCTION_WORDS.has(s)) return 'function-word'
  const pre = commonPrefix(d, s)
  const suf = commonSuffix(d, s)
  if (pre >= 4 && pre >= Math.min(d.length, s.length) - 4) return 'word-family'
  const lev = levenshtein(d, s)
  if (lev <= 2 && Math.abs(d.length - s.length) <= 1) return 'near-sound'
  if (suf >= 4 && pre < 2) return 'prefix'
  if (lev <= 2) return 'near-sound'
  return 'semantic'
}

export interface DiffResult {
  /** Paired display/spoken words (same length as display). */
  pairs: { display: RawWord; spoken: string; isIncorrect: boolean; trapCategory?: TrapCategory }[]
  /** Spoken words with no display counterpart, or vice-versa — HIW requires 1:1 substitutions. */
  problems: string[]
}

/**
 * Align a displayed transcript with what is actually spoken. HIW only substitutes
 * words one-for-one, so differing word counts are reported as problems.
 */
export function diffTranscripts(displayText: string, spokenText: string): DiffResult {
  const display = splitWords(displayText)
  const spoken = splitWords(spokenText).map((w) => w.core)
  const problems: string[] = []
  if (display.length !== spoken.length) {
    problems.push(`word-count:${display.length}:${spoken.length}`)
  }
  const pairs = display.map((dw, i) => {
    const sw = spoken[i] ?? dw.core
    const isIncorrect = normalizeWord(dw.core) !== normalizeWord(sw)
    return { display: dw, spoken: sw, isIncorrect, trapCategory: isIncorrect ? guessTrapCategory(dw.core, sw) : undefined }
  })
  return { pairs, problems }
}

export function buildTokens(
  pairs: DiffResult['pairs'],
  timings: { startMs: number; endMs: number }[],
): Token[] {
  return pairs.map((p, index) => ({
    index,
    displayText: p.display.core,
    spokenText: p.spoken,
    startMs: timings[index]?.startMs ?? 0,
    endMs: timings[index]?.endMs ?? 0,
    isIncorrect: p.isIncorrect,
    trapCategory: p.trapCategory,
    leading: p.display.leading,
    trailing: p.display.trailing,
    breakAfter: p.display.breakAfter || undefined,
  }))
}

/**
 * Anchor words for recovery training: numbers, capitalised words mid-sentence,
 * and long content words. A heuristic, not a POS tagger.
 */
export function isAnchor(tokens: readonly Token[], i: number): boolean {
  const t = tokens[i]
  const w = t.displayText
  if (/\d/.test(w)) return true
  const prev = tokens[i - 1]
  const sentenceStart = !prev || /[.!?]/.test(prev.trailing)
  if (!sentenceStart && /^\p{Lu}/u.test(w)) return true
  return w.length >= 8 && !FUNCTION_WORDS.has(w.toLowerCase())
}
