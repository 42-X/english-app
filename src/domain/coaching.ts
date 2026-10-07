import type { SpeedAdvice } from './adaptive'
import type { FalsePositiveRow, MismatchRow } from './analysis'
import type { AttemptSummary, Confidence, Focus, TrapCategory } from './types'

/** A coaching line: an i18n key plus parameters. Deterministic — no LLM involved. */
export interface Coaching {
  key: string
  params?: Record<string, string | number>
  tone: 'good' | 'warn' | 'info'
}

const pct = (x: number) => Math.round(x * 100)

export function attemptCoaching(
  s: AttemptSummary,
  rows: readonly MismatchRow[],
  fps: readonly FalsePositiveRow[],
  confidence: Record<number, Confidence>,
  guidedOnly: boolean,
): Coaching[] {
  const out: Coaching[] = []
  const { score, sync } = s

  if (sync === null) out.push({ key: 'coach.noTracking', tone: 'warn' })
  else {
    out.push({
      key: sync.within2 >= 0.9 ? 'coach.syncGood' : sync.within2 >= 0.75 ? 'coach.syncOk' : 'coach.syncWeak',
      params: { pct: pct(sync.within2) },
      tone: sync.within2 >= 0.9 ? 'good' : sync.within2 >= 0.75 ? 'info' : 'warn',
    })
  }
  if (guidedOnly) return out

  if (score.mismatches > 0 && score.hits === score.mismatches && score.falsePositives === 0) {
    out.unshift({ key: 'coach.perfect', tone: 'good' })
  } else if (score.mismatches === 0 && score.falsePositives === 0) {
    out.unshift({ key: 'coach.cleanZero', tone: 'good' })
  }

  if (score.falsePositives >= 2 || (score.falsePositives >= 1 && score.falsePositives >= score.hits)) {
    out.push({
      key: score.recall !== null && score.recall >= 0.6 ? 'coach.overclickHeard' : 'coach.overclick',
      params: { hits: score.hits, mismatches: score.mismatches, fps: score.falsePositives },
      tone: 'warn',
    })
  }
  if (fps.some((f) => f.causes.includes('position-slip'))) out.push({ key: 'coach.positionSlip', tone: 'info' })

  const lossMisses = rows.filter((r) => !r.selected && (r.state === 'lost' || r.state === 'drift'))
  const syncedMisses = rows.filter((r) => !r.selected && r.state === 'synced')
  if (lossMisses.length > 0) {
    out.push({
      key: syncedMisses.length === 0 && score.hits > 0 ? 'coach.missesAllDuringLoss' : 'coach.missesDuringLoss',
      params: { n: lossMisses.length },
      tone: 'warn',
    })
  }
  if (syncedMisses.length > 0) {
    const cats = [...new Set(syncedMisses.map((r) => r.token.trapCategory).filter((c): c is TrapCategory => !!c))]
    out.push({ key: 'coach.syncedMisses', params: { n: syncedMisses.length, cats: cats.join(',') }, tone: 'info' })
  }
  if (s.lateClicks > 0) out.push({ key: 'coach.late', params: { n: s.lateClicks }, tone: 'info' })

  const labelled = Object.keys(confidence).length
  if (labelled > 0 && fps.length > 0) {
    const guessFps = fps.filter((f) => confidence[f.token.index] === 'guess' || confidence[f.token.index] === 'medium').length
    const guessHits = rows.filter((r) => r.selected && (confidence[r.token.index] === 'guess' || confidence[r.token.index] === 'medium')).length
    if (guessFps > guessHits) {
      out.push({ key: 'coach.confidenceSkip', params: { fps: guessFps, total: fps.length, gain: guessFps - guessHits }, tone: 'warn' })
    }
  }
  return out
}

export function focusCoaching(f: Focus): Coaching {
  switch (f.type) {
    case 'trap':
      return { key: 'focus.trap', params: { cat: f.category }, tone: 'info' }
    default:
      return { key: `focus.${f.type}`, tone: 'info' }
  }
}

export function speedCoaching(a: SpeedAdvice): Coaching {
  switch (a.kind) {
    case 'not-enough-data':
      return { key: 'speed.notEnough', params: { speed: a.speed, have: a.have, need: a.need }, tone: 'info' }
    case 'ready-up':
      return { key: 'speed.readyUp', params: { speed: a.speed, next: a.next }, tone: 'good' }
    case 'step-down':
      return {
        key: 'speed.stepDown',
        params: {
          speed: a.speed,
          previous: a.previous,
          syncNow: pct(a.stats.within2 ?? 0),
          syncBase: pct(a.baseline.within2 ?? 0),
        },
        tone: 'warn',
      }
    case 'hold':
      return { key: 'speed.hold', params: { speed: a.speed }, tone: 'info' }
  }
}
