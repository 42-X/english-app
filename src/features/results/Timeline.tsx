import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FalsePositiveRow, MismatchRow } from '../../domain/analysis'
import { lagOf, stateOfLag, syncSegments, type SyncState } from '../../domain/sync'
import type { Interaction, TrackingSample } from '../../domain/types'
import { useI18n } from '../../i18n'
import { clock } from '../../ui/format'

const STATE_COLOR: Record<SyncState, string> = {
  synced: 'var(--status-good)',
  drift: 'var(--status-warning)',
  lost: 'var(--status-critical)',
  untracked: 'var(--status-none)',
}

const LAG_MIN = -10
const LAG_MAX = 5
const PAD = { l: 34, r: 10, t: 10 }
const LINE_H = 110
const STRIP_Y = PAD.t + LINE_H + 8
const STRIP_H = 10
const EVENTS_Y = STRIP_Y + STRIP_H + 22
const AXIS_Y = EVENTS_Y + 22
const HEIGHT = AXIS_Y + 16

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(600)
  useLayoutEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

interface Props {
  samples: TrackingSample[]
  durationMs: number
  rows: MismatchRow[]
  fps: FalsePositiveRow[]
  interactions: Interaction[]
  blackouts: [number, number][]
}

export function Timeline({ samples, durationMs, rows, fps, interactions, blackouts }: Props) {
  const { t, tk } = useI18n()
  const [wrap, width] = useWidth<HTMLDivElement>()
  const [hoverT, setHoverT] = useState<number | null>(null)
  const plotW = Math.max(100, width - PAD.l - PAD.r)
  const end = Math.max(durationMs, samples[samples.length - 1]?.t ?? 0)
  const x = (ms: number) => PAD.l + (ms / end) * plotW
  const y = (lag: number) => PAD.t + ((LAG_MAX - Math.max(LAG_MIN, Math.min(LAG_MAX, lag))) / (LAG_MAX - LAG_MIN)) * LINE_H

  const segments = useMemo(() => syncSegments(samples, end), [samples, end])
  const path = useMemo(() => {
    let d = ''
    let pen = false
    for (const s of samples) {
      const lag = lagOf(s)
      if (lag === null || s.spoken < 0) {
        pen = false
        continue
      }
      d += `${pen ? 'L' : 'M'}${x(s.t).toFixed(1)},${y(lag).toFixed(1)}`
      pen = true
    }
    return d
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samples, width, end])

  const fpClicks = fps.map((f) => {
    let at = 0
    for (const i of interactions) if (i.tokenIndex === f.token.index && i.action === 'select') at = i.t
    return { f, at }
  })

  const ticks: number[] = []
  const step = end > 40_000 ? 10_000 : 5_000
  for (let ms = 0; ms <= end; ms += step) ticks.push(ms)

  // Hover: nearest sample + nearest event.
  const hover = useMemo(() => {
    if (hoverT === null) return null
    let best: TrackingSample | null = null
    for (const s of samples) if (!best || Math.abs(s.t - hoverT) < Math.abs(best.t - hoverT)) best = s
    const lag = best ? lagOf(best) : null
    const ev =
      rows.find((r) => Math.abs((r.token.startMs + r.token.endMs) / 2 - hoverT) < 500) ??
      fpClicks.find((c) => Math.abs(c.at - hoverT) < 500)
    return { t: hoverT, lag, state: stateOfLag(lag), ev }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoverT, samples, rows])

  const onMove = (clientX: number) => {
    const rect = wrap.current?.getBoundingClientRect()
    if (!rect) return
    const px = clientX - rect.left - PAD.l
    if (px < 0 || px > plotW) return setHoverT(null)
    setHoverT((px / plotW) * end)
  }

  const legend: { key: SyncState; label: string }[] = [
    { key: 'synced', label: `${t('sync.synced')} (±2)` },
    { key: 'drift', label: `${t('sync.drift')} (3–4)` },
    { key: 'lost', label: `${t('sync.lost')} (5+)` },
    { key: 'untracked', label: t('sync.untracked') },
  ]

  return (
    <div>
      <div
        ref={wrap}
        className="relative w-full touch-pan-y"
        onPointerMove={(e) => onMove(e.clientX)}
        onPointerDown={(e) => onMove(e.clientX)}
        onPointerLeave={() => setHoverT(null)}
      >
        <svg width={width} height={HEIGHT} role="img" aria-label={t('results.timeline')} className="block overflow-visible">
          {/* Acceptable band ±2 */}
          <rect x={PAD.l} y={y(2)} width={plotW} height={y(-2) - y(2)} fill="var(--good-soft)" />
          {[LAG_MAX, 0, -5, LAG_MIN].map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={PAD.l + plotW} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeDasharray={v === 0 ? undefined : '2 4'} />
              <text x={PAD.l - 6} y={y(v) + 4} textAnchor="end" fontSize={11} fill="var(--ink-3)">
                {v > 0 ? `+${v}` : v}
              </text>
            </g>
          ))}
          {blackouts.map(([a, b], i) => (
            <rect key={i} x={x(a)} y={PAD.t} width={Math.max(2, x(b) - x(a))} height={LINE_H} fill="var(--surface-3)" opacity={0.8} />
          ))}
          {rows.map((r) => (
            <line
              key={r.token.index}
              x1={x((r.token.startMs + r.token.endMs) / 2)}
              x2={x((r.token.startMs + r.token.endMs) / 2)}
              y1={PAD.t}
              y2={EVENTS_Y}
              stroke="var(--ink-3)"
              strokeDasharray="2 3"
              opacity={0.5}
            />
          ))}
          <path d={path} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

          {/* Sync health strip */}
          {segments.map((s, i) => (
            <rect
              key={i}
              x={x(s.startT) + (i ? 1 : 0)}
              y={STRIP_Y}
              width={Math.max(1, x(s.endT) - x(s.startT) - (i ? 1 : 0))}
              height={STRIP_H}
              rx={2}
              fill={STATE_COLOR[s.state]}
            />
          ))}

          {/* Events: hit ●, miss ✕, false click ▲ */}
          {rows.map((r) => {
            const cx = x((r.token.startMs + r.token.endMs) / 2)
            return r.selected ? (
              <circle key={r.token.index} cx={cx} cy={EVENTS_Y} r={6} fill="var(--good)" stroke="var(--surface)" strokeWidth={2} />
            ) : (
              <g key={r.token.index} stroke="var(--bad)" strokeWidth={2.5} strokeLinecap="round">
                <line x1={cx - 5} y1={EVENTS_Y - 5} x2={cx + 5} y2={EVENTS_Y + 5} />
                <line x1={cx - 5} y1={EVENTS_Y + 5} x2={cx + 5} y2={EVENTS_Y - 5} />
              </g>
            )
          })}
          {fpClicks.map(({ f, at }) => (
            <path key={f.token.index} d={`M${x(at)},${EVENTS_Y - 6} l6,11 h-12 z`} fill="var(--warn)" stroke="var(--surface)" strokeWidth={1.5} />
          ))}

          {ticks.map((ms) => (
            <text key={ms} x={x(ms)} y={AXIS_Y + 10} textAnchor="middle" fontSize={11} fill="var(--ink-3)">
              {clock(ms)}
            </text>
          ))}

          {hover && <line x1={x(hover.t)} x2={x(hover.t)} y1={PAD.t} y2={EVENTS_Y + 8} stroke="var(--ink-2)" strokeWidth={1} />}
          {hover && hover.lag !== null && <circle cx={x(hover.t)} cy={y(hover.lag)} r={4} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />}
        </svg>
        {hover && (
          <div
            className="pointer-events-none absolute top-0 z-10 w-max max-w-56 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-ink shadow-lg"
            style={{ left: Math.min(Math.max(0, x(hover.t) + 10), Math.max(0, width - 180)) }}
          >
            <div className="font-medium tabular-nums">{clock(hover.t)}</div>
            <div className="text-ink-2">
              {tk(`sync.${hover.state}`)}
              {hover.lag !== null && ` · ${hover.lag > 0 ? '+' : ''}${hover.lag}`}
            </div>
            {hover.ev && 'token' in hover.ev && (
              <div className="mt-0.5">
                {hover.ev.token.displayText} → {hover.ev.token.spokenText} · {hover.ev.selected ? t('results.hit') : t('results.miss')}
              </div>
            )}
            {hover.ev && 'f' in hover.ev && (
              <div className="mt-0.5">
                ▲ {hover.ev.f.token.displayText} · {t('results.fps')}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded bg-[var(--series-1)]" />
          {t('results.col.lag')}
        </span>
        {legend.map((l) => (
          <span key={l.key} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: STATE_COLOR[l.key] }} />
            {l.label}
          </span>
        ))}
        <span>
          <span className="text-good">●</span> {t('results.hit').replace('✓ ', '')}
        </span>
        <span>
          <span className="text-bad">✕</span> {t('results.miss').replace('✗ ', '')}
        </span>
        <span>
          <span className="text-warn">▲</span> {t('results.fps')}
        </span>
      </div>
    </div>
  )
}
