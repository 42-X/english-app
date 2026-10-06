import type { ExerciseKind, Mode } from '../domain/types'

export interface ModeRules {
  layout: 'training' | 'exam'
  /** Current-word highlight strategy. */
  guidance: 'full' | 'fading' | 'none'
  /** Learner can select words. */
  selectable: boolean
  canPause: boolean
  liveCoaching: boolean
  /** Speed is fixed to this value regardless of settings. */
  fixedSpeed?: number
  countdown: boolean
  anchors: boolean
  /** Content kinds suitable for this mode, best first. */
  kinds: ExerciseKind[]
}

export const MODE_RULES: Record<Mode, ModeRules> = {
  guided: { layout: 'training', guidance: 'full', selectable: false, canPause: true, liveCoaching: true, fixedSpeed: 1, countdown: false, anchors: false, kinds: ['guided', 'easy', 'realistic'] },
  fading: { layout: 'training', guidance: 'fading', selectable: true, canPause: true, liveCoaching: true, fixedSpeed: 1, countdown: false, anchors: false, kinds: ['easy', 'guided', 'realistic'] },
  practice: { layout: 'training', guidance: 'none', selectable: true, canPause: true, liveCoaching: true, countdown: false, anchors: false, kinds: ['easy', 'realistic'] },
  drill: { layout: 'training', guidance: 'none', selectable: true, canPause: true, liveCoaching: true, countdown: false, anchors: false, kinds: ['drill', 'realistic'] },
  recovery: { layout: 'training', guidance: 'none', selectable: true, canPause: false, liveCoaching: true, countdown: false, anchors: true, kinds: ['recovery', 'realistic'] },
  overclick: { layout: 'exam', guidance: 'none', selectable: true, canPause: false, liveCoaching: false, countdown: false, anchors: false, kinds: ['overclick'] },
  exam: { layout: 'exam', guidance: 'none', selectable: true, canPause: false, liveCoaching: false, fixedSpeed: 1, countdown: true, anchors: false, kinds: ['realistic', 'easy', 'overclick', 'recovery'] },
  stress: { layout: 'exam', guidance: 'none', selectable: true, canPause: false, liveCoaching: false, countdown: true, anchors: false, kinds: ['realistic', 'recovery'] },
  review: { layout: 'training', guidance: 'none', selectable: true, canPause: true, liveCoaching: true, countdown: false, anchors: false, kinds: ['drill', 'realistic', 'overclick'] },
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
