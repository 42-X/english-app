import { useCallback, useEffect, useRef, useState } from 'react'
import { createAudioEngine, isAudioUnlocked, unlockAudio, type AudioEngine } from '../../audio/engine'
import { finalSelection } from '../../domain/scoring'
import { spokenIndexAt } from '../../domain/timing'
import type { Exercise, Interaction, Mode, TrackingCheck, TrackingSample } from '../../domain/types'

/**
 * loading → (needs-tap) → countdown → playing ⇄ paused → ended
 * Like the exam, the countdown starts by itself; `needs-tap` only appears when the browser
 * hasn't allowed audio yet (first visit, or a page reload straight into an exercise).
 */
export type Phase = 'loading' | 'needs-tap' | 'countdown' | 'playing' | 'paused' | 'ended' | 'error'

const SAMPLE_MS = 100
const BLACKOUT_MS = 1800
const CHECK_WINDOW_MS = 4000

/** Media-time windows where recovery training hides the transcript. */
function blackoutPlan(ex: Exercise, mode: Mode): [number, number][] {
  if (mode !== 'recovery') return []
  const n = ex.tokens.length
  return [0.35, 0.7]
    .map((f) => ex.tokens[Math.floor(n * f)]?.startMs)
    .filter((t): t is number => t !== undefined)
    .map((t) => [t, t + BLACKOUT_MS])
}

/** When to ask "tap the word you just heard" (guided/fading only), as fractions of the passage. */
function checkPlan(ex: Exercise, mode: Mode): number[] {
  if (mode !== 'guided' && mode !== 'fading') return []
  const n = ex.tokens.length
  return [0.45, 0.68, 0.88].map((f) => ex.tokens[Math.floor(n * f)]?.startMs).filter((t): t is number => t !== undefined)
}

export interface PlayerSession {
  phase: Phase
  spoken: number
  pointer: number | null
  selected: Set<number>
  mediaMs: number
  blackout: boolean
  countdown: number
  exactTiming: boolean
  /** A tracking check is waiting for the learner's tap. */
  checking: boolean
  /** Last check outcome, shown briefly: words off (0 = exact) or null for missed. */
  checkFeedback: { off: number | null } | null
  begin: () => void
  togglePause: () => void
  setVolume: (v: number) => void
  setPointer: (i: number) => void
  /** Tap/click on a word: answers a pending check, otherwise toggles selection. */
  tap: (i: number) => void
  collect: () => {
    samples: TrackingSample[]
    interactions: Interaction[]
    selected: number[]
    blackouts: [number, number][]
    checks: TrackingCheck[]
    startedAt: number
  }
}

export function usePlayerSession(ex: Exercise | undefined, mode: Mode, speed: number, countdownSec: number, selectable: boolean): PlayerSession {
  const engine = useRef<AudioEngine | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [spoken, setSpoken] = useState(-1)
  const [pointer, setPointerState] = useState<number | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [mediaMs, setMediaMs] = useState(0)
  const [blackout, setBlackout] = useState(false)
  const [countdown, setCountdown] = useState(countdownSec)
  const [checking, setChecking] = useState(false)
  const [checkFeedback, setCheckFeedback] = useState<{ off: number | null } | null>(null)

  const pointerRef = useRef<number | null>(null)
  const selectedRef = useRef<Set<number>>(new Set())
  const samples = useRef<TrackingSample[]>([])
  const interactions = useRef<Interaction[]>([])
  const blackouts = useRef<[number, number][]>([])
  const checkTimes = useRef<number[]>([])
  const checks = useRef<TrackingCheck[]>([])
  const pendingCheck = useRef<{ check: TrackingCheck; wall: number } | null>(null)
  const startedAt = useRef(0)
  const phaseRef = useRef<Phase>('loading')
  const spokenRef = useRef(-1)

  const go = (p: Phase) => {
    phaseRef.current = p
    setPhase(p)
  }

  useEffect(() => {
    if (!ex) return
    const e = createAudioEngine(ex)
    engine.current = e
    e.setRate(speed)
    e.onEnded(() => go('ended'))
    e.load().then(
      () => {
        if (isAudioUnlocked()) {
          setCountdown(countdownSec)
          go('countdown')
        } else go('needs-tap')
      },
      () => go('error'),
    )
    blackouts.current = blackoutPlan(ex, mode)
    checkTimes.current = checkPlan(ex, mode)
    return () => {
      e.destroy()
      engine.current = null
    }
  }, [ex, mode, speed, countdownSec])

  const resolveCheck = useCallback((answer: number | null) => {
    const p = pendingCheck.current
    if (!p) return
    pendingCheck.current = null
    p.check.answer = answer
    p.check.responseMs = answer === null ? null : Math.round(performance.now() - p.wall)
    checks.current.push(p.check)
    setChecking(false)
    setCheckFeedback({ off: answer === null ? null : answer - p.check.spoken })
    setTimeout(() => setCheckFeedback(null), 1600)
  }, [])

  // Playback loop: spoken index, tracking samples, blackouts, tracking checks.
  useEffect(() => {
    if (phase !== 'playing' || !ex) return
    let raf = 0
    let lastSample = 0
    const tick = (now: number) => {
      const e = engine.current
      if (!e) return
      const t = e.currentMs()
      const s = spokenIndexAt(ex.tokens, t)
      if (s !== spokenRef.current) {
        spokenRef.current = s
        setSpoken(s)
      }
      setMediaMs(t)
      if (now - lastSample >= SAMPLE_MS) {
        lastSample = now
        samples.current.push({ t: Math.round(t), spoken: s, pointer: pointerRef.current })
      }
      setBlackout(blackouts.current.some(([a, b]) => t >= a && t < b))
      const due = checkTimes.current[0]
      if (due !== undefined && t >= due && !pendingCheck.current) {
        checkTimes.current.shift()
        pendingCheck.current = { check: { t: Math.round(t), spoken: s, answer: null, responseMs: null }, wall: now }
        setChecking(true)
      }
      if (pendingCheck.current && now - pendingCheck.current.wall > CHECK_WINDOW_MS) resolveCheck(null)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [phase, ex, resolveCheck])

  // Countdown ("Beginning in N seconds"), then the recording plays by itself.
  useEffect(() => {
    if (phase !== 'countdown') return
    if (countdown <= 0) {
      startedAt.current = Date.now()
      engine.current?.play().then(
        () => go('playing'),
        () => go('needs-tap'),
      )
      return
    }
    const id = setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => clearTimeout(id)
  }, [phase, countdown])

  /** Only needed when the browser blocked audio: one tap unlocks it and starts the countdown. */
  const begin = useCallback(() => {
    if (phaseRef.current !== 'needs-tap') return
    unlockAudio()
    void engine.current?.prime()
    setCountdown((c) => (c > 0 ? c : countdownSec))
    go('countdown')
  }, [countdownSec])

  const togglePause = useCallback(() => {
    const e = engine.current
    if (!e) return
    if (phaseRef.current === 'playing') {
      e.pause()
      go('paused')
    } else if (phaseRef.current === 'paused') {
      e.play().then(() => go('playing'))
    }
  }, [])

  const setVolume = useCallback((v: number) => engine.current?.setVolume(v), [])

  const setPointer = useCallback((i: number) => {
    pointerRef.current = i
    setPointerState(i)
  }, [])

  const tap = useCallback(
    (i: number) => {
      pointerRef.current = i
      setPointerState(i)
      if (pendingCheck.current) return resolveCheck(i)
      const p = phaseRef.current
      if (!selectable || (p !== 'playing' && p !== 'paused' && p !== 'ended')) return
      const next = new Set(selectedRef.current)
      const action = next.has(i) ? 'deselect' : 'select'
      if (action === 'select') next.add(i)
      else next.delete(i)
      selectedRef.current = next
      interactions.current.push({ tokenIndex: i, action, t: Math.round(engine.current?.currentMs() ?? 0), spoken: spokenRef.current })
      setSelected(next)
    },
    [selectable, resolveCheck],
  )

  const collect = useCallback(
    () => ({
      samples: samples.current,
      interactions: interactions.current,
      selected: finalSelection(interactions.current),
      blackouts: blackouts.current.filter(([a]) => samples.current.some((s) => s.t >= a)),
      checks: checks.current,
      startedAt: startedAt.current,
    }),
    [],
  )

  return {
    phase,
    spoken,
    pointer,
    selected,
    mediaMs,
    blackout,
    countdown,
    exactTiming: ex?.timing === 'exact' && ex.source !== 'browser-tts',
    checking,
    checkFeedback,
    begin,
    togglePause,
    setVolume,
    setPointer,
    tap,
    collect,
  }
}
