// Core domain model. Pure data — no React, no storage.

export const TRAP_CATEGORIES = [
  'singular-plural',
  'verb-tense',
  'ed-ending',
  'ing-ending',
  'function-word',
  'preposition',
  'number',
  'date',
  'near-sound',
  'academic-vocab',
  'word-family',
  'noun-adjective',
  'verb-noun',
  'prefix',
  'suffix',
  'semantic',
  'connected-speech',
] as const
export type TrapCategory = (typeof TRAP_CATEGORIES)[number]

/** What the content was written to train. */
export type ExerciseKind = 'guided' | 'easy' | 'realistic' | 'drill' | 'overclick' | 'recovery'

/** How the learner is practising it. */
export const MODES = ['guided', 'fading', 'practice', 'drill', 'recovery', 'overclick', 'exam', 'stress', 'review'] as const
export type Mode = (typeof MODES)[number]

/** Practice speeds. 0.8–0.9× are learning aids; the exam itself is 1.0×. */
export const SPEEDS = [0.8, 0.9, 1, 1.05, 1.1, 1.15, 1.2, 1.3] as const
export type Speed = (typeof SPEEDS)[number]

export type Accent = 'US' | 'UK' | 'AU' | 'IN' | 'CA' | 'other'

/** exact = word timestamps from the audio source; approximate = estimated. */
export type TimingQuality = 'exact' | 'approximate'

export type AudioSource = 'tts-timestamped' | 'recorded' | 'browser-tts'

export interface Token {
  index: number
  displayText: string
  spokenText: string
  /** Media time in ms (playback-rate independent). */
  startMs: number
  endMs: number
  isIncorrect: boolean
  trapCategory?: TrapCategory
  /** Punctuation / quotes shown before and after the word; never selectable. */
  leading: string
  trailing: string
  /** Paragraph break after this token. */
  breakAfter?: boolean
}

export interface Exercise {
  id: string
  title: string
  topic: string
  kind: ExerciseKind
  difficulty: 1 | 2 | 3
  source: AudioSource
  audioUrl?: string
  durationMs: number
  accent: Accent
  voice?: string
  timing: TimingQuality
  tokens: Token[]
  tags: string[]
  /** Attribution for third-party recordings (required by their licence). */
  credit?: { work: string; author: string; license: string; url?: string; note?: string }
  /** True for learner-created exercises. */
  custom?: boolean
  /** Kept only so past attempts still open; never offered for practice. */
  archived?: boolean
  createdAt?: number
  updatedAt?: number
}

export interface TrackingSample {
  /** Media time ms. */
  t: number
  spoken: number
  /** Pointer token index, or null before the learner has pointed at anything. */
  pointer: number | null
}

export interface Interaction {
  tokenIndex: number
  action: 'select' | 'deselect'
  /** Media time ms at the moment of the click. */
  t: number
  /** Spoken token index at the click. */
  spoken: number
}

/** Tracking check: "tap the word you just heard" prompt during guided/fading playback. */
export interface TrackingCheck {
  /** Media time the prompt appeared. */
  t: number
  /** Spoken token index at the prompt. */
  spoken: number
  /** Token the learner tapped, or null if no answer in time. */
  answer: number | null
  /** Wall-clock ms from prompt to answer. */
  responseMs: number | null
}

export type Confidence = 'high' | 'medium' | 'guess'

export interface Attempt {
  id: string
  exerciseId: string
  mode: Mode
  speed: number
  timing: TimingQuality
  startedAt: number
  completedAt: number
  /** Final selected token indexes. */
  selected: number[]
  interactions: Interaction[]
  samples: TrackingSample[]
  /** Media times of recovery-training blackouts [start, end]. */
  blackouts: [number, number][]
  checks?: TrackingCheck[]
  confidence: Record<number, Confidence>
  planId?: string
  /** Denormalised summary so lists/dashboards don't recompute. */
  summary: AttemptSummary
  updatedAt: number
}

export interface ScoreResult {
  hits: number
  falsePositives: number
  misses: number
  mismatches: number
  selections: number
  /** Floored at 0 — the simulated question score. */
  net: number
  /** Unfloored hits − false positives. */
  rawNet: number
  precision: number | null
  recall: number | null
  falsePositiveRate: number
}

export interface SyncMetrics {
  /** Share of samples that had a pointer position. */
  coverage: number
  within1: number
  within2: number
  behind3: number
  ahead3: number
  avgLag: number
  medianLag: number
  maxBehind: number
  lossEvents: number
  avgRecoveryMs: number | null
  longestRecoveryMs: number | null
}

export interface AttemptSummary {
  score: ScoreResult
  sync: SyncMetrics | null
  avgLatencyMs: number | null
  lateClicks: number
  missesDuringLoss: number
  missesWhileSynced: number
  trapMisses: Partial<Record<TrapCategory, number>>
  trapTotals: Partial<Record<TrapCategory, number>>
  accent: Accent
  kind: ExerciseKind
  /** Exercise difficulty at the time (1 easier · 2 exam standard · 3 harder). Missing on old attempts. */
  difficulty?: number
}

export interface MistakeItem {
  id: string
  type: 'miss' | 'false-positive'
  display: string
  spoken: string
  trapCategory?: TrapCategory
  exerciseId: string
  tokenIndex: number
  context: string
  createdAt: number
  /** 0..4; 4 = mastered. */
  step: number
  dueAt: number
  lapses: number
  lastReviewedAt?: number
  updatedAt: number
}

export interface PlanItem {
  exerciseId: string
  mode: Mode
  speed: number
  block: 'warmup' | 'drill' | 'realistic' | 'review'
  reason: string
  attemptId?: string
}

export interface DailyPlan {
  id: string
  /** 'daily' plan (default) or a diagnostic test session. */
  kind?: 'daily' | 'overclick-test'
  date: string
  focus: Focus[]
  items: PlanItem[]
  createdAt: number
  updatedAt: number
}

export type Focus =
  | { type: 'tracking' }
  | { type: 'overclicking' }
  | { type: 'discrimination' }
  | { type: 'latency' }
  | { type: 'trap'; category: TrapCategory }
  | { type: 'baseline' }

export interface FadingConfig {
  /** Fraction of the passage with full current-word highlight. */
  full: number
  /** Fraction with only a subtle line cue. Remainder has none. */
  line: number
}

export interface Settings {
  language: 'zh-TW' | 'en'
  theme: 'system' | 'light' | 'dark'
  speed: number
  fading: FadingConfig
  liveCoaching: boolean
  /** "Beginning in N seconds" before every recording, like the exam. */
  countdownSec: number
  updatedAt: number
}

/** A word the learner saved to "My words". */
export interface VocabEntry {
  /** Lower-cased headword. */
  id: string
  word: string
  phonetic?: string
  /** Pronunciation audio from the dictionary, when available. */
  audioUrl?: string
  meanings: { partOfSpeech: string; definition: string; example?: string }[]
  /** The sentence she met it in. */
  context?: string
  exerciseId?: string
  tokenIndex?: number
  status: 'learning' | 'known'
  addedAt: number
  knownAt?: number
  updatedAt: number
}
