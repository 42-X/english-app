import type { ExerciseKind, Mode } from '../domain/types'

export interface ModeRules {
  /** Current-word highlight strategy. */
  guidance: 'full' | 'fading' | 'none'
  /** Learner can select words. */
  selectable: boolean
  canPause: boolean
  liveCoaching: boolean
  /** Speed is fixed to this value regardless of settings. */
  fixedSpeed?: number
  anchors: boolean
  /** Content kinds suitable for this mode, best first. */
  kinds: ExerciseKind[]
}

export const MODE_RULES: Record<Mode, ModeRules> = {
  guided: { guidance: 'full', selectable: false, canPause: true, liveCoaching: true, fixedSpeed: 1, anchors: false, kinds: ['realistic', 'easy', 'overclick', 'guided'] },
  fading: { guidance: 'fading', selectable: true, canPause: true, liveCoaching: true, fixedSpeed: 1, anchors: false, kinds: ['realistic', 'easy', 'guided'] },
  practice: { guidance: 'none', selectable: true, canPause: true, liveCoaching: true, anchors: false, kinds: ['easy', 'realistic'] },
  drill: { guidance: 'none', selectable: true, canPause: true, liveCoaching: true, anchors: false, kinds: ['realistic', 'easy', 'drill'] },
  recovery: { guidance: 'none', selectable: true, canPause: false, liveCoaching: true, anchors: true, kinds: ['realistic', 'recovery'] },
  overclick: { guidance: 'none', selectable: true, canPause: false, liveCoaching: false, anchors: false, kinds: ['overclick'] },
  exam: { guidance: 'none', selectable: true, canPause: false, liveCoaching: false, fixedSpeed: 1, anchors: false, kinds: ['realistic', 'easy', 'overclick', 'recovery'] },
  stress: { guidance: 'none', selectable: true, canPause: false, liveCoaching: false, anchors: false, kinds: ['realistic', 'recovery'] },
  review: { guidance: 'none', selectable: true, canPause: true, liveCoaching: true, anchors: false, kinds: ['realistic', 'overclick', 'drill'] },
}

export const STRESS_SPEEDS = [1.1, 1.15, 1.2, 1.3] as const

export function effectiveSpeed(mode: Mode, requested: number): number {
  const r = MODE_RULES[mode]
  if (r.fixedSpeed) return r.fixedSpeed
  if (mode === 'stress' && requested < 1.1) return 1.1
  return requested
}

/** Guidance at a point in the passage, for fading mode. */
export function fadingGuidance(progress: number, full: number, line: number): 'word' | 'line' | 'none' {
  if (progress < full) return 'word'
  if (progress < full + line) return 'line'
  return 'none'
}
