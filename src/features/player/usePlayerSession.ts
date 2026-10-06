import { useCallback, useEffect, useRef, useState } from 'react'
import { createAudioEngine, type AudioEngine } from '../../audio/engine'
import { finalSelection } from '../../domain/scoring'
import { spokenIndexAt } from '../../domain/timing'
import type { Exercise, Interaction, Mode, TrackingSample } from '../../domain/types'

export type Phase = 'loading' | 'ready' | 'countdown' | 'playing' | 'paused' | 'ended' | 'error'

const SAMPLE_MS = 100
const BLACKOUT_MS = 1800

/** Media-time windows where recovery training hides the transcript. */
function blackoutPlan(ex: Exercise, mode: Mode): [number, number][] {
  if (mode !== 'recovery') return []
  const n = ex.tokens.length
  return [0.35, 0.7]
    .map((f) => ex.tokens[Math.floor(n * f)]?.startMs)
    .filter((t): t is number => t !== undefined)
    .map((t) => [t, t + BLACKOUT_MS])
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
  start: () => void
  togglePause: () => void
  setPointer: (i: number) => void
  toggle: (i: number) => void
  /** Snapshot of everything recorded, for building the attempt. */
  collect: () => { samples: TrackingSample[]; interactions: Interaction[]; selected: number[]; blackouts: [number, number][]; startedAt: number }
}

export function usePlayerSession(ex: Exercise | undefined, mode: Mode, speed: number, countdownSec: number): PlayerSession {
  const engine = useRef<AudioEngine | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [spoken, setSpoken] = useState(-1)
  const [pointer, setPointerState] = useState<number | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [mediaMs, setMediaMs] = useState(0)
  const [blackout, setBlackout] = useState(false)
  const [countdown, setCountdown] = useState(0)

  const pointerRef = useRef<number | null>(null)
  const samples = useRef<TrackingSample[]>([])
  const interactions = useRef<Interaction[]>([])
  const blackouts = useRef<[number, number][]>([])
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
      () => go('ready'),
      () => go('error'),
    )
    blackouts.current = blackoutPlan(ex, mode)
    return () => {
      e.destroy()
      engine.current = null
    }
  }, [ex, mode, speed])

  // Playback loop: spoken index, tracking samples, blackouts.
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
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [phase, ex])

  // Exam countdown, then auto-play.
  useEffect(() => {
    if (phase !== 'countdown') return
    if (countdown <= 0) {
      startedAt.current = Date.now()
      engine.current?.play().then(
        () => go('playing'),
        () => go('error'),
      )
      return
    }
    const id = setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => clearTimeout(id)
  }, [phase, countdown])

  const start = useCallback(() => {
    const e = engine.current
    if (!e || phaseRef.current !== 'ready') return
    if (countdownSec > 0) {
      // Unlock audio inside the user gesture (iOS) before the countdown ends.
      void e.prime()
      setCountdown(countdownSec)
      go('countdown')
      return
    }
    startedAt.current = Date.now()
    e.play().then(
      () => go('playing'),
      () => go('error'),
    )
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

  const setPointer = useCallback((i: number) => {
    pointerRef.current = i
    setPointerState(i)
  }, [])

  const toggle = useCallback((i: number) => {
    const p = phaseRef.current
    if (p !== 'playing' && p !== 'paused' && p !== 'ended') return
    const t = Math.round(engine.current?.currentMs() ?? 0)
    setSelected((prev) => {
      const next = new Set(prev)
      const action = next.has(i) ? 'deselect' : 'select'
      if (action === 'select') next.add(i)
      else next.delete(i)
      interactions.current.push({ tokenIndex: i, action, t, spoken: spokenRef.current })
      return next
    })
    pointerRef.current = i
    setPointerState(i)
  }, [])

  const collect = useCallback(
    () => ({
      samples: samples.current,
      interactions: interactions.current,
      selected: finalSelection(interactions.current),
      blackouts: blackouts.current.filter(([a]) => samples.current.some((s) => s.t >= a)),
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
    start,
    togglePause,
    setPointer,
    toggle,
    collect,
  }
}
