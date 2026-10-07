import { describe, expect, it } from 'vitest'
import { speedAdvice, targetLevel, weaknesses } from './adaptive'
import { falsePositiveRows, mismatchRows, summarize } from './analysis'
import { clickLatencyMs, latencyBucket } from './latency'
import { buildBonusRound, buildDailyPlan, buildOverclickTest, localDate, mismatchCount, trimLegacyQuest } from './plan'
import { lastSevenDays, milestone, milestoneReachedToday, recommendations, resultMood, wins } from './momentum'
import { overclickReport, pointLosses, rollingDiagnosis, sessionSummary } from './report'
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

  it('adds FIB-L and a WFD set when listening data is given', () => {
    const human = lib.map((e) => ({ ...e, tags: ['human-audio'] }))
    const wfd = Array.from({ length: 10 }, (_, k) => ({ id: `r1:${k}`, exerciseId: 'r1', from: k, to: k + 8, startMs: 0, endMs: 4000, text: '', words: [] }))
    const plan = buildDailyPlan({
      date: '2026-10-06', exercises: human, attempts: [], mistakes: [], speed: 1, now: 0,
      listening: { fiblLast: new Map(), fiblAccuracy: 0.5, wfd, wfdLast: new Map([['r1:0', 5]]) },
    })
    const fibl = plan.items.filter((i) => i.task === 'fibl')
    expect(fibl).toHaveLength(1) // the quest stays short; bonus rounds add more
    expect(new Set(plan.items.map((i) => i.exerciseId + i.task)).size).toBe(plan.items.length)
    const set = plan.items.find((i) => i.task === 'wfd')!
    expect(set.sentences).toHaveLength(6)
    expect(set.sentences).not.toContain('r1:0') // done recently → not repeated first
  })

  it('emphasises over-click training when precision is low', () => {
    const ex = lib[8]
    const as = Array.from({ length: 5 }, () => attempt({ ex, selected: [5, 15, 1, 2, 3, 4] }))
    const plan = buildDailyPlan({ date: 'd', exercises: lib, attempts: as, mistakes: [], speed: 1, now: 0 })
    expect(plan.items.filter((i) => i.mode === 'overclick').length).toBe(1)
    const more = buildBonusRound({ date: 'd', exercises: lib, attempts: as, mistakes: [], speed: 1, now: 0 }, plan)
    expect(more.some((i) => i.mode === 'overclick')).toBe(true)
  })

  it('keeps the daily quest short and finishable', () => {
    const plan = buildDailyPlan({ date: 'd', exercises: lib, attempts: [], mistakes: [], speed: 1, now: 0 })
    expect(plan.items.length).toBeLessThanOrEqual(6)
    expect(plan.items.every((i) => !i.bonus)).toBe(true)
  })

  it('leaves exam conditions out of the quest while she is struggling', () => {
    const ex = lib[8]
    // Pointer far behind the audio → weak sync → easier level.
    const as = Array.from({ length: 5 }, () => attempt({ ex, samples: samples(40, () => -6) }))
    const plan = buildDailyPlan({ date: 'd', exercises: lib, attempts: as, mistakes: [], speed: 1, now: 0 })
    expect(plan.items.some((i) => i.mode === 'exam')).toBe(false)
  })

  it('trims a long pre-quest plan to six quest items, keeping finished work', () => {
    const items = Array.from({ length: 10 }, (_, k) => ({ exerciseId: `e${k}`, mode: 'practice' as const, speed: 1, block: 'realistic' as const, reason: 'realistic', attemptId: k < 3 ? `a${k}` : undefined }))
    const plan = { id: 'p', date: 'd', focus: [], items, createdAt: 0, updatedAt: 0 }
    const t = trimLegacyQuest(plan)!
    expect(t.items.filter((i) => !i.bonus)).toHaveLength(6)
    expect(t.items.filter((i) => i.attemptId)).toHaveLength(3)
    expect(trimLegacyQuest(t)).toBeNull()
  })

  it('bonus rounds never repeat a passage already in today’s plan', () => {
    const input = { date: 'd', exercises: lib, attempts: [], mistakes: [], speed: 1, now: 0 }
    let plan = buildDailyPlan(input)
    for (let k = 0; k < 2; k++) {
      const round = buildBonusRound(input, plan)
      expect(round.length).toBeGreaterThan(0)
      expect(round.every((i) => i.bonus)).toBe(true)
      plan = { ...plan, items: [...plan.items, ...round] }
    }
    const ids = plan.items.map((i) => i.exerciseId)
    expect(new Set(ids).size).toBe(ids.length)
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

describe('difficulty level', () => {
  const ex = exercise(40, { 5: 'word-family', 15: 'singular-plural', 30: 'near-sound' })
  it('starts at exam standard', () => {
    expect(targetLevel([])).toBe(2)
  })
  it('drops to easier passages while sync is weak', () => {
    const as = Array.from({ length: 5 }, () => attempt({ ex, samples: samples(40, (t) => (t % 4000 < 2500 ? -6 : 0)) }))
    expect(targetLevel(as)).toBe(1)
  })
  it('rises only after 20 stable passages', () => {
    expect(targetLevel(Array.from({ length: 19 }, () => attempt({ ex })))).toBe(2)
    expect(targetLevel(Array.from({ length: 20 }, () => attempt({ ex })))).toBe(3)
  })
})

describe('over-clicking test', () => {
  const lib: Exercise[] = [
    ...Array.from({ length: 4 }, (_, i) => exercise(80, {}, { id: `z${i}`, kind: 'overclick' })),
    ...Array.from({ length: 5 }, (_, i) => exercise(80, { 10: 'number' }, { id: `o${i}`, kind: 'overclick' })),
    ...Array.from({ length: 4 }, (_, i) => exercise(80, { 10: 'number', 40: 'semantic' }, { id: `t${i}`, kind: 'realistic' })),
    exercise(80, { 1: 'number', 2: 'number', 3: 'number' }, { id: 'many', kind: 'realistic' }),
  ]
  it('builds 10 passages with 0–2 mismatches in a 3/4/3 mix', () => {
    const test = buildOverclickTest({ date: 'd', exercises: lib, attempts: [], now: 5 })!
    expect(test.items).toHaveLength(10)
    const counts = test.items.map((i) => mismatchCount(lib.find((e) => e.id === i.exerciseId)!))
    expect(counts.filter((c) => c === 0)).toHaveLength(3)
    expect(counts.filter((c) => c === 1)).toHaveLength(4)
    expect(Math.max(...counts)).toBeLessThanOrEqual(2)
    expect(test.items.every((i) => i.mode === 'overclick' && i.speed === 1)).toBe(true)
  })
  it('diagnoses a decision-threshold problem from clicks on clean passages', () => {
    const zero = lib[0]
    const one = lib[4]
    const as = [attempt({ ex: zero, selected: [3, 9] }), attempt({ ex: zero, selected: [20] }), attempt({ ex: one, selected: [10] })]
    const r = overclickReport(as, new Map(lib.map((e) => [e.id, e])))
    expect(r).toMatchObject({ zeroPassages: 2, clicksOnZero: 3, falseClicks: 3, profile: 'threshold' })
  })
  it('separates tracking from discrimination when clicks are clean but misses are high', () => {
    const two = lib[9]
    const lost = Array.from({ length: 4 }, () => attempt({ ex: two, selected: [], samples: samples(80, () => -8) }))
    expect(overclickReport(lost, new Map(lib.map((e) => [e.id, e]))).profile).toBe('tracking')
    const heard = Array.from({ length: 4 }, () => attempt({ ex: two, selected: [], samples: samples(80, () => 0) }))
    expect(overclickReport(heard, new Map(lib.map((e) => [e.id, e]))).profile).toBe('discrimination')
  })
})

describe('reports', () => {
  const ex = exercise(40, { 5: 'word-family', 15: 'singular-plural', 30: 'near-sound' })
  const map = new Map([[ex.id, ex]])
  it('attributes lost points to false clicks, lost sync and trap types', () => {
    const a = attempt({ ex, selected: [5, 1, 2], samples: samples(40, (t) => (t >= 5500 && t < 6800 ? -7 : 0)) })
    const losses = pointLosses([a], map)
    expect(losses).toContainEqual({ source: 'false-clicks', points: 2 })
    expect(losses).toContainEqual({ source: 'lost-sync', points: 1 })
    expect(losses).toContainEqual({ source: 'trap:near-sound', points: 1 })
  })
  it('summarises a session against the previous days', () => {
    const before = Array.from({ length: 4 }, () => attempt({ ex, selected: [5, 1, 2, 3] }))
    const today = Array.from({ length: 3 }, () => attempt({ ex }))
    const s = sessionSummary(today, before, [...today, ...before], map)
    expect(s.net).toBe(9)
    expect(s.maxNet).toBe(9)
    expect(s.improved.map((d) => d.metric)).toEqual(expect.arrayContaining(['precision', 'fpPerPassage']))
  })
  it('writes a rolling diagnosis with trends', () => {
    const before = Array.from({ length: 5 }, () => attempt({ ex, selected: [5, 1, 2] }))
    const now = Array.from({ length: 5 }, () => attempt({ ex, selected: [5, 15, 30] }))
    const lines = rollingDiagnosis(now, before, map)
    expect(lines[0]).toMatchObject({ key: 'diag.catchAndFalse', params: { recall: 100, fp: 0, rTrend: ' (+67)' } })
  })
})

describe('vocabulary', () => {
  it('normalises headwords', async () => {
    const { headword } = await import('./vocab')
    expect(headword('“Resilience,”')).toBe('resilience')
    expect(headword("Earth's")).toBe("earth's")
    expect(headword('long-term.')).toBe('long-term')
  })
  it('parses a dictionary response, capping definitions', async () => {
    const { parseDictionary } = await import('./vocab')
    const r = parseDictionary([
      {
        word: 'resilience',
        phonetics: [{ text: '/rɪˈzɪliəns/' }, { audio: 'https://x/resilience.mp3' }],
        meanings: [
          { partOfSpeech: 'noun', definitions: [{ definition: 'The ability to recover quickly.', example: 'the resilience of the economy' }, { definition: 'Elasticity.' }, { definition: 'Third one.' }] },
        ],
      },
    ])!
    expect(r.phonetic).toBe('/rɪˈzɪliəns/')
    expect(r.audioUrl).toBe('https://x/resilience.mp3')
    expect(r.meanings).toHaveLength(2)
    expect(r.meanings[0]).toMatchObject({ partOfSpeech: 'noun', example: 'the resilience of the economy' })
  })
  it('returns null for "no definitions found"', async () => {
    const { parseDictionary } = await import('./vocab')
    expect(parseDictionary({ title: 'No Definitions Found' })).toBeNull()
  })
  it('finds the next milestone', async () => {
    const { nextMilestone } = await import('./vocab')
    expect(nextMilestone(0)).toBe(5)
    expect(nextMilestone(25)).toBe(50)
  })
})

describe('wiktionary fallback', () => {
  it('parses definitions and strips markup', async () => {
    const { parseWiktionary } = await import('./vocab')
    const r = parseWiktionary('awareness', {
      en: [{ partOfSpeech: 'Noun', definitions: [{ definition: 'The state of <a href="/wiki/consciousness">consciousness</a> &amp; perception.', examples: ['<i>public</i> awareness'] }, { definition: '' }] }],
    })!
    expect(r.meanings).toEqual([{ partOfSpeech: 'noun', definition: 'The state of consciousness & perception.', example: 'public awareness' }])
    expect(parseWiktionary('x', { fr: [] })).toBeNull()
  })
})

describe('listening: answers', () => {
  it('accepts British and American spellings but not lookalike mistakes', async () => {
    const { sameWord } = await import('./listening')
    for (const [a, b] of [['colour', 'color'], ['behaviour', 'behavior'], ['organised', 'organized'], ['analyse', 'analyze'], ['centre', 'center'], ['travelled', 'traveled'], ['defence', 'defense'], ['Resilience,', 'resilience']])
      expect(sameWord(a, b), `${a}/${b}`).toBe(true)
    for (const [a, b] of [['four', 'for'], ['filled', 'filed'], ['does', 'des'], ['sense', 'sence'], ['hour', 'hor']]) expect(sameWord(a, b), `${a}/${b}`).toBe(false)
  })
  it('classifies wrong answers', async () => {
    const { classifyAnswer } = await import('./listening')
    expect(classifyAnswer('developments', 'development')).toBe('ending')
    expect(classifyAnswer('increased', 'increase')).toBe('ending')
    expect(classifyAnswer('environment', 'enviroment')).toBe('spelling')
    expect(classifyAnswer('necessary', 'neccessary')).toBe('spelling')
    expect(classifyAnswer('climate', 'culture')).toBe('wrong')
    expect(classifyAnswer('climate', '  ')).toBe('blank')
    expect(classifyAnswer('climate', 'Climate.')).toBe('correct')
    for (const [e, t] of [['these', 'this'], ['they', 'the'], ['any', 'and'], ['in', 'is']]) expect(classifyAnswer(e, t), `${e}/${t}`).toBe('wrong')
  })
})

describe('listening: FIB-L blanks', () => {
  it('chooses spaced content words, never names or function words, deterministically', async () => {
    const { fiblBlanks } = await import('./listening')
    const words = 'The Hippocampus plays important roles in the consolidation of information from short-term memory to long-term memory and in spatial memory that enables navigation. In humans and other primates the structure is located in the medial temporal lobe and Alzheimer damages it early because neurons there are vulnerable to reduced oxygen and chronic stress over many decades of life.'.split(' ')
    const ex = exercise(words.length, {}, { id: 'fib-test' })
    ex.tokens.forEach((t, i) => {
      t.spokenText = t.displayText = words[i].replace(/[.,]/g, '')
      t.trailing = /[.]$/.test(words[i]) ? '.' : ''
    })
    const blanks = fiblBlanks(ex)
    expect(blanks.length).toBeGreaterThanOrEqual(5)
    expect(blanks).toEqual(fiblBlanks(ex))
    for (let k = 1; k < blanks.length; k++) expect(blanks[k] - blanks[k - 1]).toBeGreaterThanOrEqual(4)
    for (const b of blanks) {
      const w = ex.tokens[b].spokenText
      expect(w.length).toBeGreaterThanOrEqual(4)
      expect(['Alzheimer', 'Hippocampus', 'other', 'there', 'because']).not.toContain(w)
    }
  })
})

describe('listening: WFD', () => {
  it('scores one point per correct word, order-insensitive, and explains misses', async () => {
    const { scoreWfd } = await import('./listening')
    const r = scoreWfd('The students submitted their assignments before the deadline'.split(' '), 'the students submit there assignment before deadline extra')
    expect(r.total).toBe(8)
    expect(r.correct).toBe(4) // the, students, before, deadline
    const kinds = Object.fromEntries(r.words.map((w) => [w.expected, w.kind]))
    expect(kinds.submitted).toBe('ending')
    expect(kinds.assignments).toBe('ending')
    expect(kinds.their).toBe('blank') // "there" is a different word: their counts as missing, "there" as extra
    expect(r.extra).toEqual(['there', 'extra'])
  })
  it('extracts dictation sentences of exam length without digits', async () => {
    const { extractWfd } = await import('./listening')
    const words = 'Intro words here. Many students find dictation difficult because the speaker does not pause. In 1990 the test changed completely and forever for everyone involved.'.split(' ')
    const ex = exercise(words.length, {}, { id: 'wfd-test', tags: ['human-audio'] })
    ex.tokens.forEach((t, i) => {
      t.spokenText = t.displayText = words[i].replace(/[.,]/g, '')
      t.trailing = /[.]$/.test(words[i]) ? '.' : ''
    })
    const s = extractWfd([ex])
    expect(s.map((x) => x.words.join(' '))).toEqual(['Many students find dictation difficult because the speaker does not pause'])
    expect(s[0].startMs).toBeGreaterThanOrEqual(ex.tokens[2].endMs)
  })
})

describe('listening: stats and coaching', () => {
  const fibl = {
    id: 'a', task: 'fibl' as const, exerciseId: 'e', mode: 'practice' as const, startedAt: 0, completedAt: 0, updatedAt: 0, correct: 2, total: 5,
    items: [
      { ref: '1', exerciseId: 'e', expected: 'climate', typed: 'climate', correct: 1, total: 1, kinds: ['correct' as const] },
      { ref: '5', exerciseId: 'e', expected: 'emissions', typed: 'emission', correct: 0, total: 1, kinds: ['ending' as const] },
      { ref: '9', exerciseId: 'e', expected: 'adaptation', typed: 'adaptasion', correct: 0, total: 1, kinds: ['spelling' as const] },
      { ref: '14', exerciseId: 'e', expected: 'reducing', typed: '', correct: 0, total: 1, kinds: ['blank' as const] },
      { ref: '20', exerciseId: 'e', expected: 'renewable', typed: 'renewable', correct: 1, total: 1, kinds: ['correct' as const] },
    ],
  }
  it('aggregates accuracy, error kinds and missed words', async () => {
    const { listeningStats } = await import('./listening')
    const s = listeningStats([fibl])
    expect(s.fibl).toMatchObject({ attempts: 1, correct: 2, total: 5, accuracy: 0.4 })
    expect(s.wfd.accuracy).toBeNull()
    expect(s.kinds).toEqual({ correct: 2, ending: 1, spelling: 1, wrong: 0, blank: 1 })
    expect(s.topWords.map((w) => w.word)).toEqual(['adaptation', 'emissions', 'reducing'])
  })
  it('coaches the biggest loss and tells her to guess blanks (no negative marking)', async () => {
    const { listeningCoaching } = await import('./listening')
    const keys = listeningCoaching(fibl).map((c) => c.key)
    expect(keys[0]).toBe('lst.score')
    expect(keys).toEqual(expect.arrayContaining(['lst.ending', 'lst.spelling', 'lst.blank.fibl']))
  })
})

describe('listening: spelling bank filter', () => {
  it('keeps heard-but-misspelled words and substantial missed words only', async () => {
    const { worthReviewing } = await import('./listening')
    expect(worthReviewing('the', 'spelling')).toBe(true)
    expect(worthReviewing('the', 'blank')).toBe(false)
    expect(worthReviewing('which', 'wrong')).toBe(false)
    expect(worthReviewing('emissions', 'blank')).toBe(true)
    expect(worthReviewing('emissions', 'correct')).toBe(false)
  })
})

describe('momentum', () => {
  const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime()

  it('sets the next points milestone and spots one passed today', () => {
    expect(milestone(0)).toEqual({ prev: 0, next: 25 })
    expect(milestone(264)).toEqual({ prev: 250, next: 500 })
    expect(milestone(2600)).toEqual({ prev: 2500, next: 5000 })
    expect(milestone(5200)).toEqual({ prev: 5000, next: 7500 })
    expect(milestoneReachedToday(240, 264)).toBe(250)
    expect(milestoneReachedToday(251, 264)).toBeNull()
  })

  it('lists the last seven days ending today', () => {
    const week = lastSevenDays(new Set([localDate(at(2026, 10, 6))]), at(2026, 10, 6))
    expect(week).toHaveLength(7)
    expect(week[6]).toMatchObject({ today: true, active: true })
    expect(week[0].date).toBe(localDate(at(2026, 9, 30)))
  })

  it('adds up effort and earned points', () => {
    const perfect = attempt({ startedAt: 0, completedAt: 60_000 })
    const w = wins([perfect], [{ id: 'l', task: 'wfd', exerciseId: 'e', mode: 'practice', items: [], correct: 7, total: 10, startedAt: 0, completedAt: 120_000, updatedAt: 0 }])
    expect(w).toMatchObject({ done: 2, minutes: 3, caught: 3, written: 7, perfect: 1 })
  })

  it('frames results against her own average', () => {
    expect(resultMood(1, true, [])).toBe('perfect')
    expect(resultMood(0.5, false, [0.3, 0.3, 0.3])).toBe('better')
    expect(resultMood(0.7, false, [])).toBe('good')
    expect(resultMood(0.3, false, [0.35, 0.3, 0.4])).toBe('steady')
    expect(resultMood(0.1, false, [0.6, 0.7, 0.6])).toBe('tough')
  })

  it('recommends quick review first, then her weakest area', () => {
    const lib = [
      exercise(30, { 3: 'number' }, { id: 'a', kind: 'realistic' }),
      exercise(30, { 3: 'near-sound' }, { id: 'b', kind: 'realistic' }),
      exercise(30, {}, { id: 'o', kind: 'overclick' }),
    ]
    const due = Array.from({ length: 3 }, (_, k) =>
      recordMistake(undefined, { type: 'miss', display: `x${k}`, spoken: `y${k}`, exerciseId: 'a', tokenIndex: 3, context: '' }, 0),
    )
    const overclicky = Array.from({ length: 5 }, () => attempt({ ex: lib[0], selected: [3, 1, 2, 4, 5] }))
    const recs = recommendations({ exercises: lib, attempts: overclicky, listening: [], mistakes: due, learningWords: 0, now: INTERVALS[0] + 1 })
    expect(recs[0]).toMatchObject({ kind: 'review', due: 3 })
    expect(recs[1]).toMatchObject({ kind: 'overclicking', exerciseId: 'o' })
    expect(recs).toHaveLength(3)
  })
})

describe('changes of mind', () => {
  it('tells apart unclicks that saved a point from ones that lost a point', async () => {
    const { mindChanges } = await import('./analysis')
    const ex = exercise(20, { 3: 'near-sound', 9: 'suffix' })
    const at = (tokenIndex: number, action: 'select' | 'deselect', t: number) => ({ tokenIndex, action, t, spoken: 0 })
    const m = mindChanges(ex, [at(3, 'select', 1), at(3, 'deselect', 2), at(5, 'select', 3), at(5, 'deselect', 4), at(9, 'select', 5), at(9, 'deselect', 6), at(9, 'select', 7)])
    expect(m).toEqual({ lost: [3], saved: [5], reclicked: [9] })
  })
})

describe('coach summary', () => {
  it('summarises effort, skills and recent results, and renders a text report', async () => {
    const { coachSummary, coachMarkdown } = await import('./coach')
    const ex = exercise(40, { 5: 'word-family', 15: 'singular-plural', 30: 'near-sound' }, { id: 'ex1', title: 'Passage one' })
    const now = new Date(2026, 9, 7, 12).getTime()
    const attempts = [attempt({ ex, completedAt: now - 3600_000, startedAt: now - 3660_000, selected: [5, 15] }), attempt({ ex, completedAt: now - 86_400_000, startedAt: now - 86_460_000 })]
    const s = coachSummary({ attempts, listening: [], mistakes: [], exById: new Map([[ex.id, ex]]), now })
    expect(s.daysActive14).toBe(2)
    expect(s.days).toHaveLength(2)
    expect(s.recent[0]).toMatchObject({ task: 'HIW', title: 'Passage one', score: '2/3', extraClicks: 0 })
    const md = coachMarkdown('Learner', s, now)
    expect(md).toContain('# PTE listening practice — Learner')
    expect(md).toContain('| HIW | practice | Passage one | 2/3 |')
  })
})
