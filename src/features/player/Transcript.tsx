import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Token } from '../../domain/types'

export interface TranscriptProps {
  tokens: readonly Token[]
  layout: 'training' | 'exam'
  /** Show spoken words instead of displayed (guided tracking: transcript matches audio). */
  showSpoken?: boolean
  selected: ReadonlySet<number>
  /** Current-word highlight. */
  highlight?: number | null
  /** Subtle cue on the line containing this token. */
  lineCue?: number | null
  anchors?: ReadonlySet<number> | null
  /** Show a marker under the learner's pointer (touch tracking). */
  pointerMarker?: number | null
  interactive: boolean
  /** Tracking active: block page scrolling so a finger can slide over the text. */
  tracking: boolean
  hidden?: boolean
  /**
   * Spoken token to keep on screen. Long passages don't fit on a phone and a finger on the text
   * is tracking (it can't scroll), so the page scrolls itself when the spoken line nears the bottom.
   */
  follow?: number | null
  onPointerToken?: (index: number, kind: 'mouse' | 'touch') => void
  onToggle?: (index: number) => void
  /** Optional per-token decoration for results review. */
  decorate?: (t: Token) => string | undefined
  renderWord?: (t: Token) => React.ReactNode
}

// A finger tap may wobble and linger a little; anything beyond this is a slide (tracking), not a tap.
const TAP_MAX_MOVE = 18
const TAP_MAX_MS = 600

/** The word under a point — or, in the gap between two words, the nearest one. */
function tokenAt(x: number, y: number): number | null {
  for (const [dx, dy] of [[0, 0], [-5, 0], [5, 0], [-10, 0], [10, 0], [0, -6], [0, 6]]) {
    const el = document.elementFromPoint(x + dx, y + dy)?.closest<HTMLElement>('[data-i]')
    if (el) return Number(el.dataset.i)
  }
  return null
}

export function Transcript(p: TranscriptProps) {
  const root = useRef<HTMLDivElement>(null)
  const down = useRef<{ x: number; y: number; t: number; i: number | null; type: string; moved: boolean } | null>(null)
  const [lineTop, setLineTop] = useState<number | null>(null)

  useLayoutEffect(() => {
    if (p.follow === null || p.follow === undefined || !root.current) return
    const el = root.current.querySelector<HTMLElement>(`[data-i="${p.follow}"]`)
    if (!el) return
    const r = el.getBoundingClientRect()
    const margin = window.innerHeight * 0.22
    if (r.bottom > window.innerHeight - margin) window.scrollBy({ top: r.top - window.innerHeight * 0.4, behavior: 'smooth' })
    else if (r.top < 60) window.scrollBy({ top: r.top - window.innerHeight * 0.3, behavior: 'smooth' })
  }, [p.follow])

  useLayoutEffect(() => {
    if (p.lineCue === null || p.lineCue === undefined || !root.current) return setLineTop(null)
    const el = root.current.querySelector<HTMLElement>(`[data-i="${p.lineCue}"]`)
    setLineTop(el ? el.offsetTop : null)
  }, [p.lineCue])

  const report = (e: ReactPointerEvent, i: number | null) => {
    if (i === null || !p.onPointerToken) return
    p.onPointerToken(i, e.pointerType === 'mouse' ? 'mouse' : 'touch')
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!p.interactive && !p.tracking) return
    const i = tokenAt(e.clientX, e.clientY)
    if (e.pointerType === 'mouse') {
      // Mouse: select the moment the button goes down. Waiting for the release dropped clicks
      // whenever the cursor was still moving along with the audio.
      if (e.button === 0 && p.interactive && i !== null) p.onToggle?.(i)
      return
    }
    down.current = { x: e.clientX, y: e.clientY, t: performance.now(), i, type: e.pointerType, moved: false }
    try {
      root.current?.setPointerCapture(e.pointerId)
    } catch {
      // Not all pointers can be captured (e.g. synthetic events); tracking still works via elementFromPoint.
    }
    report(e, i)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse') {
      if (p.tracking) report(e, tokenAt(e.clientX, e.clientY))
      return
    }
    const d = down.current
    if (!d) return
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_MAX_MOVE) d.moved = true
    if (p.tracking) report(e, tokenAt(e.clientX, e.clientY))
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = down.current
    down.current = null
    if (!d || !p.interactive || d.i === null) return
    const moved = d.moved || Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_MAX_MOVE
    // A short, still touch is a tap on the word where the finger came down.
    if (!moved && performance.now() - d.t <= TAP_MAX_MS) p.onToggle?.(d.i)
  }

  const exam = p.layout === 'exam'
  return (
    <div
      ref={root}
      className={[
        'relative select-none',
        exam ? 'transcript-exam' : 'transcript-training',
        // No double-tap zoom: on phones it delays or swallows quick taps on words.
        p.tracking ? 'touch-none' : p.interactive ? 'touch-manipulation' : '',
        p.interactive ? 'cursor-pointer' : '',
      ].join(' ')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (down.current = null)}
      onContextMenu={(e) => p.tracking && e.preventDefault()}
    >
      {lineTop !== null && <div aria-hidden className="line-cue" style={{ top: lineTop }} />}
      <p className={p.hidden ? 'blackout' : undefined}>
        {p.tokens.map((t) => {
          const cls = ['word']
          if (p.selected.has(t.index)) cls.push('word-selected')
          if (p.highlight === t.index) cls.push('word-current')
          if (p.anchors?.has(t.index)) cls.push('word-anchor')
          if (p.pointerMarker === t.index) cls.push('word-pointer')
          const deco = p.decorate?.(t)
          if (deco) cls.push(deco)
          return (
            <span key={t.index}>
              {t.leading}
              <span data-i={t.index} className={cls.join(' ')}>
                {p.renderWord ? p.renderWord(t) : p.showSpoken ? t.spokenText : t.displayText}
              </span>
              {t.trailing}
              {t.breakAfter ? (
                <>
                  <br />
                  <br />
                </>
              ) : (
                ' '
              )}
            </span>
          )
        })}
      </p>
    </div>
  )
}
