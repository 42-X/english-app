import type { ScoreResult, Token } from './types'

/**
 * PTE-style HIW simulation: hit +1, false positive −1, miss 0, question floored at 0.
 * This is a practice simulation, not Pearson's scaled scoring.
 */
export function scoreSelection(tokens: readonly Token[], selected: Iterable<number>): ScoreResult {
  const sel = new Set(selected)
  let hits = 0
  let falsePositives = 0
  let mismatches = 0
  for (const tok of tokens) {
    if (tok.isIncorrect) {
      mismatches++
      if (sel.has(tok.index)) hits++
    } else if (sel.has(tok.index)) {
      falsePositives++
    }
  }
  const selections = hits + falsePositives
  const misses = mismatches - hits
  const correctWords = tokens.length - mismatches
  const rawNet = hits - falsePositives
  return {
    hits,
    falsePositives,
    misses,
    mismatches,
    selections,
    net: Math.max(0, rawNet),
    rawNet,
    precision: selections > 0 ? hits / selections : null,
    recall: mismatches > 0 ? hits / mismatches : null,
    falsePositiveRate: correctWords > 0 ? falsePositives / correctWords : 0,
  }
}

/** Replay click history into the final selection set. */
export function finalSelection(interactions: readonly { tokenIndex: number; action: 'select' | 'deselect' }[]): number[] {
  const sel = new Set<number>()
  for (const i of interactions) {
    if (i.action === 'select') sel.add(i.tokenIndex)
    else sel.delete(i.tokenIndex)
  }
  return [...sel].sort((a, b) => a - b)
}
