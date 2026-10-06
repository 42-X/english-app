import { clickLatencyMs, latencyBucket, type LatencyBucket } from './latency'
import { scoreSelection } from './scoring'
import { lagAt, stateOfLag, syncMetrics, type SyncState } from './sync'
import type { Attempt, AttemptSummary, Exercise, Interaction, Token, TrackingSample, TrapCategory } from './types'

/** Likely causes. Always presented as "likely" / "possible", never definitive. */
export type Cause =
  | 'lost-sync'
  | 'drifting'
  | 'phonetic'
  | 'morphology'
  | 'singular-plural'
  | 'verb-tense'
  | 'function-word'
  | 'semantic'
  | 'word-family'
  | 'connected-speech'
  | 'numbers'
  | 'vocabulary'
  | 'over-click'
  | 'position-slip'
  | 'late-response'

const TRAP_CAUSES: Record<TrapCategory, Cause[]> = {
  'singular-plural': ['singular-plural', 'morphology'],
  'verb-tense': ['verb-tense', 'morphology'],
  'ed-ending': ['verb-tense', 'connected-speech'],
  'ing-ending': ['morphology'],
  'function-word': ['function-word'],
  preposition: ['function-word'],
  number: ['numbers'],
  date: ['numbers'],
  'near-sound': ['phonetic'],
  'academic-vocab': ['vocabulary', 'phonetic'],
  'word-family': ['word-family', 'morphology'],
  'noun-adjective': ['word-family', 'morphology'],
  'verb-noun': ['word-family', 'morphology'],
  prefix: ['morphology'],
  suffix: ['morphology'],
  semantic: ['semantic'],
  'connected-speech': ['connected-speech'],
}

export function trapCauses(cat: TrapCategory | undefined): Cause[] {
  return cat ? TRAP_CAUSES[cat] : []
}

export interface MismatchRow {
  token: Token
  selected: boolean
  latencyMs: number | null
  bucket: LatencyBucket | null
  /** Pointer lag while the word was spoken. */
  lag: number | null
  state: SyncState
  causes: Cause[]
}

export interface FalsePositiveRow {
  token: Token
  lag: number | null
  /** Distance to the nearest real mismatch, in words. */
  nearestMismatch: number | null
  causes: Cause[]
}

function wordMid(tok: Token): number {
  return (tok.startMs + tok.endMs) / 2
}

export function mismatchRows(ex: Exercise, a: Pick<Attempt, 'selected' | 'interactions' | 'samples' | 'speed'>): MismatchRow[] {
  const rows = rawMismatchRows(ex, a)
  // Several misses in a row with no pointer data usually means she had lost her place.
  rows.forEach((r, i) => {
    const prev = rows[i - 1]
    const next = rows[i + 1]
    const streak = (prev && !prev.selected) || (next && !next.selected)
    if (!r.selected && r.state === 'untracked' && streak && !r.causes.includes('lost-sync')) r.causes.unshift('lost-sync')
  })
  return rows
}

function rawMismatchRows(ex: Exercise, a: Pick<Attempt, 'selected' | 'interactions' | 'samples' | 'speed'>): MismatchRow[] {
  const sel = new Set(a.selected)
  return ex.tokens
    .filter((t) => t.isIncorrect)
    .map((token) => {
      const selected = sel.has(token.index)
      const latencyMs = selected ? clickLatencyMs(token, a.interactions, a.speed) : null
      const bucket = latencyMs === null ? null : latencyBucket(latencyMs)
      const lag = lagAt(a.samples, wordMid(token))
      const state = stateOfLag(lag)
      const causes: Cause[] = []
      if (!selected) {
        if (state === 'lost') causes.push('lost-sync')
        else if (state === 'drift') causes.push('drifting')
        causes.push(...trapCauses(token.trapCategory))
      } else if (bucket === 'very-late' || bucket === 'late') {
        causes.push('late-response')
      }
      return { token, selected, latencyMs, bucket, lag, state, causes: dedupe(causes) }
    })
}

export function falsePositiveRows(ex: Exercise, a: Pick<Attempt, 'selected' | 'interactions' | 'samples'>): FalsePositiveRow[] {
  const mismatchIdx = ex.tokens.filter((t) => t.isIncorrect).map((t) => t.index)
  return a.selected
    .map((i) => ex.tokens[i])
    .filter((t): t is Token => !!t && !t.isIncorrect)
    .map((token) => {
      const click = lastSelect(a.interactions, token.index)
      const lag = click ? lagAt(a.samples, click.t) : null
      const nearestMismatch = mismatchIdx.length ? Math.min(...mismatchIdx.map((m) => Math.abs(m - token.index))) : null
      const causes: Cause[] = ['over-click']
      if (nearestMismatch !== null && nearestMismatch <= 2) causes.unshift('position-slip')
      if (lag !== null && Math.abs(lag) >= 3) causes.unshift('lost-sync')
      return { token, lag, nearestMismatch, causes }
    })
}

function lastSelect(interactions: readonly Interaction[], index: number): Interaction | null {
  let found: Interaction | null = null
  for (const i of interactions) if (i.tokenIndex === index) found = i.action === 'select' ? i : null
  return found
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)]
}

export function summarize(ex: Exercise, a: { selected: number[]; interactions: Interaction[]; samples: TrackingSample[]; speed: number }): AttemptSummary {
  const score = scoreSelection(ex.tokens, a.selected)
  const sync = syncMetrics(a.samples, a.speed)
  const rows = mismatchRows(ex, a)
  const latencies = rows.map((r) => r.latencyMs).filter((l): l is number => l !== null)
  const trapMisses: AttemptSummary['trapMisses'] = {}
  const trapTotals: AttemptSummary['trapTotals'] = {}
  for (const r of rows) {
    const c = r.token.trapCategory
    if (!c) continue
    trapTotals[c] = (trapTotals[c] ?? 0) + 1
    if (!r.selected) trapMisses[c] = (trapMisses[c] ?? 0) + 1
  }
  return {
    score,
    sync,
    avgLatencyMs: latencies.length ? latencies.reduce((x, y) => x + y, 0) / latencies.length : null,
    lateClicks: rows.filter((r) => r.bucket === 'late' || r.bucket === 'very-late').length,
    missesDuringLoss: rows.filter((r) => !r.selected && (r.state === 'lost' || r.state === 'drift')).length,
    missesWhileSynced: rows.filter((r) => !r.selected && r.state === 'synced').length,
    trapMisses,
    trapTotals,
    accent: ex.accent,
    kind: ex.kind,
    difficulty: ex.difficulty,
  }
}

/** Short text context around a token, for the mistake bank. `spoken` uses what was said (FIB-L / WFD). */
export function contextAround(tokens: readonly Token[], index: number, radius = 4, spoken = false): string {
  const from = Math.max(0, index - radius)
  const to = Math.min(tokens.length, index + radius + 1)
  const w = (t: Token) => (spoken ? t.spokenText : t.displayText)
  return tokens
    .slice(from, to)
    .map((t) => (t.index === index ? `[${t.leading}${w(t)}${t.trailing}]` : `${t.leading}${w(t)}${t.trailing}`))
    .join(' ')
}
