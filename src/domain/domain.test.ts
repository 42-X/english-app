import { describe, expect, it } from 'vitest'
import { speedAdvice, weaknesses } from './adaptive'
import { falsePositiveRows, mismatchRows, summarize } from './analysis'
import { clickLatencyMs, latencyBucket } from './latency'
import { buildDailyPlan } from './plan'
import { finalSelection, scoreSelection } from './scoring'
import { isDue, recordMistake, reviewMistake, INTERVALS, MASTERED } from './srs'
import { blackoutRecoveries, lossEvents, syncMetrics, syncSegments } from './sync'
import { diffTranscripts, guessTrapCategory, splitWords } from './text'
import { spokenIndexAt } from './timing'
import type { Attempt, Exercise, Token, TrackingSample, TrapCategory } from './types'

function tokens(n: number, incorrect: Record<number, TrapCategory> = {}): Token[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    displayText: `w${i}`,
    spokenText: incorrect[i] ? `s${i}` : `w${i}`,
    startMs: i * 400,
    endMs: i * 400 + 400,
    isIncorrect: i in incorrect,
    trapCategory: incorrect[i],
    leading: '',
    trailing: '',
  }))
}

function exercise(n: number, incorrect: Record<number, TrapCategory> = {}, over: Partial<Exercise> = {}): Exercise {
  return {
    id: 'ex',
    title: 't',
    topic: 'biology',
    kind: 'realistic',
    difficulty: 2,
    source: 'tts-timestamped',
    durationMs: n * 400,
    accent: 'US',
    timing: 'exact',
    tokens: tokens(n, incorrect),
    tags: [],
    ...over,
  }
}

/** Samples every 100ms; pointer = spoken + lagFn(t). */
function samples(n: number, lagFn: (t: number) => number | null): TrackingSample[] {
  const toks = tokens(n)
  const out: TrackingSample[] = []
  for (let t = 0; t < n * 400; t += 100) {
    const spoken = spokenIndexAt(toks, t)
    const lag = lagFn(t)
    out.push({ t, spoken, pointer: lag === null ? null : Math.max(0, spoken + lag) })
  }
  return out
}

function attempt(over: Partial<Attempt> & { ex?: Exercise } = {}): Attempt {
  const ex = over.ex ?? exercise(40, { 5: 'word-family', 15: 'singular-plural', 30: 'near-sound' })
  const selected = over.selected ?? [5, 15, 30]
  const interactions = over.interactions ?? selected.map((i) => ({ tokenIndex: i, action: 'select' as const, t: i * 400 + 700, spoken: i + 1 }))
  const s = over.samples ?? samples(40, () => 0)
  const speed = over.speed ?? 1
  return {
    id: Math.random().toString(36),
    exerciseId: ex.id,
    mode: 'practice',
    speed,
    timing: 'exact',
    startedAt: 0,
    completedAt: over.completedAt ?? Date.now(),
    selected,
    interactions,
    samples: s,
    blackouts: [],
    confidence: {},
    summary: summarize(ex, { selected, interactions, samples: s, speed }),
    updatedAt: 0,
    ...over,
  }
}

describe('scoring', () => {
  const toks = tokens(20, { 3: 'number', 9: 'semantic', 14: 'preposition' })

  it('awards +1 hit, −1 false positive, 0 miss', () => {
    const r = scoreSelection(toks, [3, 9, 1])
    expect(r).toMatchObject({ hits: 2, falsePositives: 1, misses: 1, mismatches: 3, selections: 3, net: 1, rawNet: 1 })
    expect(r.precision).toBeCloseTo(2 / 3)
    expect(r.recall).toBeCloseTo(2 / 3)
    expect(r.falsePositiveRate).toBeCloseTo(1 / 17)
  })

  it('floors the question score at zero but keeps the raw value', () => {
    const r = scoreSelection(toks, [0, 1, 2, 3])
    expect(r.net).toBe(0)
    expect(r.rawNet).toBe(-2)
  })

  it('returns null precision with no selections and null recall with no mismatches', () => {
    expect(scoreSelection(toks, []).precision).toBeNull()
    expect(scoreSelection(tokens(10), [1]).recall).toBeNull()
  })

  it('replays select/deselect history', () => {
    expect(
      finalSelection([
        { tokenIndex: 4, action: 'select' },
        { tokenIndex: 2, action: 'select' },
        { tokenIndex: 4, action: 'deselect' },
      ]),
    ).toEqual([2])
  })
})

describe('timing', () => {
  it('finds the spoken token by media time', () => {
    const toks = tokens(5)
    expect(spokenIndexAt(toks, -1)).toBe(-1)
    expect(spokenIndexAt(toks, 0)).toBe(0)
    expect(spokenIndexAt(toks, 399)).toBe(0)
    expect(spokenIndexAt(toks, 400)).toBe(1)
    expect(spokenIndexAt(toks, 99_999)).toBe(4)
  })
})

describe('synchronization', () => {
  it('reports perfect sync when the pointer follows the audio', () => {
    const m = syncMetrics(samples(30, () => 0))!
    expect(m.within1).toBe(1)
    expect(m.within2).toBe(1)
    expect(m.lossEvents).toBe(0)
    expect(m.avgLag).toBe(0)
  })

  it('detects a loss event and its recovery time', () => {
    // 4–6 s: six words behind, otherwise synced.
    const s = samples(30, (t) => (t >= 4000 && t < 6000 ? -6 : 0))
    const ev = lossEvents(s)
    expect(ev).toHaveLength(1)
    expect(ev[0].worstLag).toBe(-6)
    expect(ev[0].recoveryMs).toBe(2000)
    const m = syncMetrics(s)!
    expect(m.lossEvents).toBe(1)
    expect(m.behind3).toBeCloseTo(20 / 120)
    expect(m.maxBehind).toBe(-6)
  })

  it('converts recovery to wall-clock time at faster playback', () => {
    const s = samples(30, (t) => (t >= 4000 && t < 6000 ? -6 : 0))
    expect(lossEvents(s, 1.25)[0].recoveryMs).toBe(1600)
  })

  it('records an unrecovered loss through the end', () => {
    const s = samples(20, (t) => (t >= 6000 ? -8 : 0))
    const ev = lossEvents(s)
    expect(ev[0].endT).toBeNull()
  })

  it('ignores samples without a pointer and reports coverage', () => {
    const m = syncMetrics(samples(20, (t) => (t < 4000 ? null : 0)))!
    expect(m.coverage).toBeCloseTo(0.5)
    expect(m.within2).toBe(1)
  })

  it('returns null when there is no tracking at all', () => {
    expect(syncMetrics(samples(10, () => null))).toBeNull()
  })

  it('builds timeline segments', () => {
    const segs = syncSegments(samples(30, (t) => (t >= 4000 && t < 5000 ? -3 : t >= 5000 && t < 6000 ? -6 : 0)))
    expect(segs.map((s) => s.state)).toEqual(['synced', 'drift', 'lost', 'synced'])
  })

  it('measures recovery after blackouts', () => {
    const s = samples(30, (t) => (t >= 4000 && t < 5500 ? -5 : 0))
    expect(blackoutRecoveries(s, [[3000, 4000]])).toEqual([1500])
  })
})

describe('latency', () => {
  const tok = tokens(10)[3] // 1200–1600
  it('measures from end of the spoken word using the final select', () => {
    const ints = [
      { tokenIndex: 3, action: 'select' as const, t: 1700, spoken: 4 },
      { tokenIndex: 3, action: 'deselect' as const, t: 1800, spoken: 4 },
      { tokenIndex: 3, action: 'select' as const, t: 2600, spoken: 6 },
    ]
    expect(clickLatencyMs(tok, ints)).toBe(1000)
    expect(clickLatencyMs(tok, ints, 2)).toBe(500)
    expect(clickLatencyMs(tok, ints.slice(0, 2))).toBeNull()
  })
  it('buckets latencies', () => {
    expect(latencyBucket(-500)).toBe('early')
    expect(latencyBucket(300)).toBe('fast')
    expect(latencyBucket(1200)).toBe('normal')
    expect(latencyBucket(2500)).toBe('late')
    expect(latencyBucket(5000)).toBe('very-late')
  })
})

describe('diagnosis', () => {
  const ex = exercise(40, { 5: 'word-family', 20: 'singular-plural' })

  it('attributes a miss during sync loss to lost synchronization', () => {
    const s = samples(40, (t) => (t >= 7000 && t < 10000 ? -6 : 0))
    const rows = mismatchRows(ex, { selected: [5], interactions: [{ tokenIndex: 5, action: 'select', t: 2500, spoken: 6 }], samples: s, speed: 1 })
    const miss = rows.find((r) => r.token.index === 20)!
    expect(miss.selected).toBe(false)
    expect(miss.state).toBe('lost')
    expect(miss.causes[0]).toBe('lost-sync')
    expect(miss.causes).toContain('singular-plural')
  })

  it('attributes a synced miss to the trap category', () => {
    const rows = mismatchRows(ex, { selected: [], interactions: [], samples: samples(40, () => 0), speed: 1 })
    expect(rows[0].causes).toEqual(['word-family', 'morphology'])
  })

  it('flags a false positive next to a real mismatch as a position slip', () => {
    const fps = falsePositiveRows(ex, { selected: [6, 33], interactions: [], samples: samples(40, () => 0) })
    expect(fps[0].causes).toContain('position-slip')
    expect(fps[1].causes).toEqual(['over-click'])
  })

  it('summarizes misses by sync state and trap', () => {
    const s = samples(40, (t) => (t >= 7000 && t < 10000 ? -6 : 0))
    const sum = summarize(ex, { selected: [], interactions: [], samples: s, speed: 1 })
    expect(sum.missesDuringLoss).toBe(1)
    expect(sum.missesWhileSynced).toBe(1)
    expect(sum.trapMisses).toEqual({ 'word-family': 1, 'singular-plural': 1 })
  })
})

describe('spaced repetition', () => {
  const base = { type: 'miss' as const, display: 'economic', spoken: 'economical', exerciseId: 'e', tokenIndex: 1, context: '' }
  it('schedules 10m → 1d → 3d → 7d → mastered', () => {
    let m = recordMistake(undefined, base, 0)
    expect(m.dueAt).toBe(INTERVALS[0])
    for (let i = 1; i < INTERVALS.length; i++) {
      m = reviewMistake(m, true, 0)
      expect(m.dueAt).toBe(INTERVALS[i])
    }
    m = reviewMistake(m, true, 0)
    expect(m.step).toBe(MASTERED)
    expect(isDue(m, Number.MAX_SAFE_INTEGER)).toBe(false)
  })
  it('resets on failure and on relapse', () => {
    let m = reviewMistake(recordMistake(undefined, base, 0), true, 0)
    m = reviewMistake(m, false, 100)
    expect(m).toMatchObject({ step: 0, lapses: 1, dueAt: 100 + INTERVALS[0] })
    m = reviewMistake(m, true, 200)
    m = recordMistake(m, base, 300)
    expect(m).toMatchObject({ step: 0, lapses: 2 })
  })
})

describe('adaptive', () => {
  const ex = exercise(40, { 5: 'word-family', 15: 'singular-plural', 30: 'near-sound' })

  it('asks for a baseline with too little data', () => {
    expect(weaknesses([attempt()])).toEqual([{ type: 'baseline' }])
  })

  it('flags over-clicking when precision is low', () => {
    const as = Array.from({ length: 5 }, () => attempt({ ex, selected: [5, 15, 30, 1, 2, 3] }))
    expect(weaknesses(as)[0]).toEqual({ type: 'overclicking' })
  })

  it('flags tracking when sync is weak', () => {
    const as = Array.from({ length: 5 }, () => attempt({ ex, samples: samples(40, (t) => (t % 4000 < 2000 ? -6 : 0)) }))
    expect(weaknesses(as).map((f) => f.type)).toContain('tracking')
  })

  it('flags a trap category that is repeatedly missed', () => {
    const as = Array.from({ length: 5 }, () => attempt({ ex, selected: [5, 30] }))
    expect(weaknesses(as)).toContainEqual({ type: 'trap', category: 'singular-plural' })
  })

  it('does not raise speed just because exercises were completed', () => {
    const sloppy = Array.from({ length: 12 }, () => attempt({ ex, selected: [5, 1] }))
    expect(speedAdvice(sloppy, 1).kind).toBe('hold')
  })

  it('recommends the next speed after stable high quality', () => {
    const good = Array.from({ length: 10 }, () => attempt({ ex }))
    expect(speedAdvice(good, 1)).toMatchObject({ kind: 'ready-up', next: 1.05 })
  })

  it('steps back down when a faster speed degrades quality', () => {
    const base = Array.from({ length: 10 }, () => attempt({ ex, speed: 1.05 }))
    const fast = Array.from({ length: 4 }, () => attempt({ ex, speed: 1.1, selected: [5, 1, 2] }))
    expect(speedAdvice([...fast, ...base], 1.1)).toMatchObject({ kind: 'step-down', previous: 1.05 })
  })

  it('needs enough data at a speed before deciding', () => {
    expect(speedAdvice([attempt()], 1)).toMatchObject({ kind: 'not-enough-data', have: 1, need: 10 })
  })
})

describe('daily plan', () => {
  const lib: Exercise[] = [
    exercise(30, {}, { id: 'g1', kind: 'guided' }),
    exercise(30, {}, { id: 'g2', kind: 'guided' }),
    exercise(30, { 3: 'number' }, { id: 'e1', kind: 'easy' }),
    exercise(30, { 3: 'singular-plural', 9: 'singular-plural' }, { id: 'd1', kind: 'drill' }),
    exercise(30, { 3: 'near-sound' }, { id: 'd2', kind: 'drill' }),
    exercise(30, {}, { id: 'o1', kind: 'overclick' }),
    exercise(30, { 5: 'number' }, { id: 'o2', kind: 'overclick' }),
    exercise(30, {}, { id: 'rc1', kind: 'recovery' }),
    ...['r1', 'r2', 'r3', 'r4'].map((id) => exercise(40, { 5: 'word-family', 15: 'singular-plural' }, { id, kind: 'realistic' })),
  ]

  it('builds a full session with no duplicates', () => {
    const plan = buildDailyPlan({ date: '2026-10-05', exercises: lib, attempts: [], mistakes: [], speed: 1, now: 0 })
    const ids = plan.items.map((i) => i.exerciseId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(plan.items[0]).toMatchObject({ mode: 'guided', block: 'warmup', speed: 1 })
    expect(plan.items.some((i) => i.mode === 'exam')).toBe(true)
  })

  it('emphasises over-click training when precision is low', () => {
    const ex = lib[8]
    const as = Array.from({ length: 5 }, () => attempt({ ex, selected: [5, 15, 1, 2, 3, 4] }))
    const plan = buildDailyPlan({ date: 'd', exercises: lib, attempts: as, mistakes: [], speed: 1, now: 0 })
    expect(plan.items.filter((i) => i.mode === 'overclick').length).toBe(2)
  })

  it('reviews due mistakes using a different exercise with the same trap', () => {
    const m = recordMistake(undefined, { type: 'miss', display: 'student', spoken: 'students', trapCategory: 'near-sound', exerciseId: 'x', tokenIndex: 3, context: '' }, 0)
    const plan = buildDailyPlan({ date: 'd', exercises: lib, attempts: [], mistakes: [m], speed: 1, now: INTERVALS[0] + 1 })
    expect(plan.items.find((i) => i.block === 'review')).toMatchObject({ exerciseId: 'd2', reason: 'review:near-sound' })
  })
})

describe('text', () => {
  it('keeps punctuation separate from words', () => {
    const w = splitWords('"Hello," she said — twice.\n\nNew para.')
    expect(w.map((x) => x.core)).toEqual(['Hello', 'she', 'said', 'twice', 'New', 'para'])
    expect(w[0]).toMatchObject({ leading: '"', trailing: ',"' })
    expect(w[2].trailing).toBe(' —')
    expect(w[3].breakAfter).toBe(true)
  })

  it('pairs display and spoken words and guesses trap categories', () => {
    const d = diffTranscripts('The economic effect of students.', 'The economical affect of student.')
    expect(d.problems).toEqual([])
    expect(d.pairs.filter((p) => p.isIncorrect).map((p) => p.trapCategory)).toEqual(['word-family', 'near-sound', 'singular-plural'])
  })

  it('reports non 1:1 transcripts', () => {
    expect(diffTranscripts('a b c', 'a b').problems).toHaveLength(1)
  })

  it.each([
    ['increase', 'increased', 'ed-ending'],
    ['develop', 'developing', 'ing-ending'],
    ['in', 'on', 'preposition'],
    ['has', 'have', 'function-word'],
    ['1990', '1991', 'date'],
    ['forty', 'fourteen', 'number'],
    ['economy', 'economics', 'word-family'],
    ['rapid', 'sudden', 'semantic'],
  ] as const)('guesses %s → %s as %s', (d, s, cat) => {
    expect(guessTrapCategory(d, s)).toBe(cat)
  })
})
