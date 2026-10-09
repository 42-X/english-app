import { db } from '../data/db'
import type { Exercise } from '../domain/types'

/**
 * Audio is abstracted so exercises can come from recorded/timestamped audio
 * (exact sync analytics) or browser speech synthesis (approximate).
 */
export interface AudioEngine {
  readonly exactTiming: boolean
  load(): Promise<void>
  setVolume(v: number): void
  /** Unlock playback inside a user gesture (iOS) without audible output. */
  prime(): Promise<void>
  play(): Promise<void>
  pause(): void
  setRate(rate: number): void
  /** Current media time in ms (independent of playback rate). */
  currentMs(): number
  onEnded(cb: () => void): void
  destroy(): void
}

// ── Shared, unlockable audio element ───────────────────────────────────
//
// Like the real exam, questions start by themselves after a countdown. Browsers (iOS in particular)
// only allow that once an audio element has been played inside a user gesture, so one element is
// shared by every exercise and unlocked by the learner's first tap/click anywhere in the app.

/** 0.1 s of 8 kHz silence. */
const SILENT_WAV = 'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA=='

let shared: HTMLAudioElement | null = null
let unlocked = false

function sharedAudio(): HTMLAudioElement {
  if (!shared) {
    shared = new Audio()
    shared.preload = 'auto'
    shared.preservesPitch = true
  }
  return shared
}

export function isAudioUnlocked(): boolean {
  return unlocked
}

/** Call inside a user gesture. Safe to call repeatedly. */
export function unlockAudio(): void {
  if (unlocked) return
  const el = sharedAudio()
  const hadSrc = el.getAttribute('src')
  if (!hadSrc) el.src = SILENT_WAV
  el.muted = true
  void el
    .play()
    .then(() => {
      el.pause()
      unlocked = true
    })
    .catch((e: unknown) => {
      // AbortError = the exercise took over the element before this finished; the browser still
      // accepted playback from the tap, so the element counts as unlocked.
      if (e instanceof DOMException && e.name === 'AbortError') unlocked = true
    })
    .finally(() => {
      el.muted = false
      if (!hadSrc) el.removeAttribute('src')
    })
  if ('speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(''))
}

/** Unlock on the first interaction anywhere in the app. */
export function installAudioUnlock(): void {
  const once = () => {
    unlockAudio()
    window.removeEventListener('pointerdown', once, true)
    window.removeEventListener('keydown', once, true)
  }
  window.addEventListener('pointerdown', once, true)
  window.addEventListener('keydown', once, true)
}

/** Custom exercises keep uploaded audio in IndexedDB under this URL scheme. */
export const LOCAL_AUDIO_PREFIX = 'local-audio:'

/**
 * Audio is loaded whole into a blob URL: files are small, it lets the service
 * worker cache plain 200 responses for offline use, and it avoids iOS range-request
 * issues with cached media.
 */
async function resolveAudioUrl(url: string): Promise<{ src: string; revoke?: () => void }> {
  let blob: Blob
  if (url.startsWith(LOCAL_AUDIO_PREFIX)) {
    const row = await db.audio.get(url.slice(LOCAL_AUDIO_PREFIX.length))
    if (!row) throw new Error('audio-missing')
    blob = row.blob
  } else {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`audio-${res.status}`)
    blob = await res.blob()
  }
  const src = URL.createObjectURL(blob)
  return { src, revoke: () => URL.revokeObjectURL(src) }
}

/** Warm the audio cache in the background so every exercise works offline. */
export function prefetchAudio(urls: string[]): void {
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
  if (conn?.saveData || !('caches' in window)) return
  const run = async () => {
    const cache = await caches.open('hiw-audio')
    for (const u of urls) {
      if (await cache.match(u)) continue
      try {
        await cache.add(u)
      } catch {
        return
      }
    }
  }
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback
  if (idle) idle(() => void run())
  else setTimeout(() => void run(), 3000)
}

export class RecordedAudioProvider implements AudioEngine {
  private el = sharedAudio()
  private revoke?: () => void
  private endedCb: (() => void) | null = null
  private onEndedEvent = () => this.endedCb?.()
  readonly exactTiming: boolean
  private url: string

  constructor(url: string, exact: boolean) {
    this.url = url
    this.exactTiming = exact
    this.el.pause()
    this.el.addEventListener('ended', this.onEndedEvent)
  }

  setVolume(v: number): void {
    this.el.volume = Math.max(0, Math.min(1, v))
  }

  async load(): Promise<void> {
    const { src, revoke } = await resolveAudioUrl(this.url)
    this.revoke = revoke
    this.el.src = src
    await new Promise<void>((resolve, reject) => {
      if (this.el.readyState >= 2) return resolve()
      const ok = () => {
        cleanup()
        resolve()
      }
      const fail = () => {
        cleanup()
        reject(new Error('audio-load'))
      }
      const cleanup = () => {
        this.el.removeEventListener('canplay', ok)
        this.el.removeEventListener('loadeddata', ok)
        this.el.removeEventListener('error', fail)
      }
      this.el.addEventListener('canplay', ok)
      this.el.addEventListener('loadeddata', ok)
      this.el.addEventListener('error', fail)
      this.el.load()
    })
  }

  async prime(): Promise<void> {
    this.el.muted = true
    try {
      await this.el.play()
      this.el.pause()
    } catch {
      // Ignored: the real play() will surface any error.
    }
    this.el.currentTime = 0
    this.el.muted = false
  }
  play(): Promise<void> {
    return this.el.play()
  }
  pause(): void {
    this.el.pause()
  }
  setRate(rate: number): void {
    this.el.playbackRate = rate
    this.el.defaultPlaybackRate = rate
  }
  currentMs(): number {
    return this.el.currentTime * 1000
  }
  onEnded(cb: () => void): void {
    this.endedCb = cb
  }
  destroy(): void {
    this.el.pause()
    this.el.removeEventListener('ended', this.onEndedEvent)
    this.el.removeAttribute('src')
    this.el.load()
    this.revoke?.()
  }
}

/**
 * Browser speech fallback. The media clock runs from wall time × rate and is
 * snapped to each word-boundary event when the browser provides them.
 */
export class BrowserSpeechProvider implements AudioEngine {
  readonly exactTiming = false
  private rate = 1
  private startWall = 0
  private offsetMs = 0
  private pausedAt: number | null = null
  private endedCb: (() => void) | null = null
  private utter: SpeechSynthesisUtterance | null = null
  private wordStarts: number[]
  private charToWord: number[] = []
  private ex: Exercise

  constructor(ex: Exercise) {
    this.ex = ex
    this.wordStarts = ex.tokens.map((t) => t.startMs)
  }

  private volume = 1

  async load(): Promise<void> {
    if (!('speechSynthesis' in window)) throw new Error('no-speech')
  }

  setVolume(v: number): void {
    this.volume = v
  }

  async prime(): Promise<void> {
    speechSynthesis.speak(new SpeechSynthesisUtterance(''))
  }

  private text(): string {
    const parts: string[] = []
    this.charToWord = []
    let pos = 0
    this.ex.tokens.forEach((t, i) => {
      const w = `${t.spokenText}${t.trailing.trim()}`
      for (let c = 0; c < w.length + 1; c++) this.charToWord[pos + c] = i
      parts.push(w)
      pos += w.length + 1
    })
    return parts.join(' ')
  }

  async play(): Promise<void> {
    if (this.pausedAt !== null && this.utter) {
      this.startWall = performance.now()
      this.offsetMs = this.pausedAt
      this.pausedAt = null
      speechSynthesis.resume()
      return
    }
    speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(this.text())
    u.lang = this.ex.accent === 'UK' ? 'en-GB' : this.ex.accent === 'AU' ? 'en-AU' : 'en-US'
    u.rate = this.rate
    u.volume = this.volume
    u.onboundary = (e) => {
      if (e.name && e.name !== 'word') return
      const i = this.charToWord[e.charIndex]
      if (i === undefined) return
      this.offsetMs = this.wordStarts[i]
      this.startWall = performance.now()
    }
    u.onend = () => this.endedCb?.()
    this.utter = u
    this.startWall = performance.now()
    this.offsetMs = 0
    speechSynthesis.speak(u)
  }

  pause(): void {
    this.pausedAt = this.currentMs()
    speechSynthesis.pause()
  }
  setRate(rate: number): void {
    this.rate = rate
  }
  currentMs(): number {
    if (this.pausedAt !== null) return this.pausedAt
    return this.offsetMs + (performance.now() - this.startWall) * this.rate
  }
  onEnded(cb: () => void): void {
    this.endedCb = cb
  }
  destroy(): void {
    if (this.utter) this.utter.onend = null
    speechSynthesis.cancel()
  }
}

export function createAudioEngine(ex: Exercise): AudioEngine {
  if (ex.audioUrl && ex.source !== 'browser-tts') return new RecordedAudioProvider(ex.audioUrl, ex.timing === 'exact')
  return new BrowserSpeechProvider(ex)
}

// ── Snippet replay for review ─────────────────────────────────────────

let current: { stop: () => void } | null = null

export function stopSnippet(): void {
  current?.stop()
  current = null
}

/** Play roughly 1 s before → word → 1 s after, at a review speed. */
export async function playSnippet(ex: Exercise, tokenIndex: number, rate: number): Promise<void> {
  stopSnippet()
  const tok = ex.tokens[tokenIndex]
  if (!tok) return
  const from = Math.max(0, tok.startMs - 1000)
  const to = tok.endMs + 1000

  if (ex.audioUrl && ex.source !== 'browser-tts') {
    // Reuse the shared (already unlocked) element: on iOS a fresh element would be blocked
    // because the fetch below outlives the tap that requested playback.
    unlockAudio()
    const { src, revoke } = await resolveAudioUrl(ex.audioUrl)
    const el = sharedAudio()
    el.src = src
    let raf = 0
    const stop = () => {
      cancelAnimationFrame(raf)
      el.pause()
      revoke?.()
    }
    current = { stop }
    await new Promise<void>((r) => {
      if (el.readyState >= 1) r()
      else el.addEventListener('loadedmetadata', () => r(), { once: true })
    })
    el.currentTime = from / 1000
    el.playbackRate = rate
    const tick = () => {
      if (el.currentTime * 1000 >= to || el.ended) return stop()
      raf = requestAnimationFrame(tick)
    }
    await el.play()
    raf = requestAnimationFrame(tick)
    return
  }

  const words = ex.tokens.filter((t) => t.endMs >= from && t.startMs <= to).map((t) => t.spokenText)
  const u = new SpeechSynthesisUtterance(words.join(' '))
  u.rate = rate
  u.lang = ex.accent === 'UK' ? 'en-GB' : 'en-US'
  speechSynthesis.cancel()
  speechSynthesis.speak(u)
  current = { stop: () => speechSynthesis.cancel() }
}

/**
 * Play a short recording (a word's pronunciation) on the shared, already-unlocked element, so it can
 * start without a tap on iOS. Resolves false when it can't play (missing file, blocked) — the caller
 * then falls back to the device voice.
 */
export async function playClip(url: string, onEnd?: () => void): Promise<boolean> {
  stopSnippet()
  try {
    const { src, revoke } = await resolveAudioUrl(url)
    const el = sharedAudio()
    el.src = src
    el.playbackRate = 1
    el.volume = 1
    let done = false
    const stop = () => {
      if (done) return
      done = true
      el.onended = null
      el.pause()
      revoke?.()
    }
    current = { stop }
    el.onended = () => {
      stop()
      onEnd?.()
    }
    await el.play()
    return true
  } catch {
    return false
  }
}

/**
 * Play one window of an exercise's recording (a WFD sentence) on the shared element.
 * Calls onProgress with 0–1 and onEnd when the window finishes. Returns a stop function.
 */
export async function playRange(
  ex: Exercise,
  startMs: number,
  endMs: number,
  handlers: { onProgress?: (frac: number) => void; onEnd?: () => void; volume?: number } = {},
): Promise<() => void> {
  stopSnippet()
  if (!ex.audioUrl || ex.source === 'browser-tts') {
    handlers.onEnd?.()
    return () => {}
  }
  unlockAudio()
  const { src, revoke } = await resolveAudioUrl(ex.audioUrl)
  const el = sharedAudio()
  el.src = src
  el.playbackRate = 1
  el.volume = handlers.volume ?? 1
  let raf = 0
  let done = false
  const stop = () => {
    if (done) return
    done = true
    cancelAnimationFrame(raf)
    el.pause()
    revoke?.()
  }
  current = { stop }
  await new Promise<void>((r) => {
    if (el.readyState >= 1) r()
    else el.addEventListener('loadedmetadata', () => r(), { once: true })
  })
  el.currentTime = startMs / 1000
  const tick = () => {
    const t = el.currentTime * 1000
    handlers.onProgress?.(Math.min(1, Math.max(0, (t - startMs) / (endMs - startMs))))
    if (t >= endMs || el.ended) {
      stop()
      handlers.onEnd?.()
      return
    }
    raf = requestAnimationFrame(tick)
  }
  await el.play()
  raf = requestAnimationFrame(tick)
  return stop
}
