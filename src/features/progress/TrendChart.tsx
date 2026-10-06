import { useLayoutEffect, useRef, useState } from 'react'

export interface Series {
  key: string
  label: string
  color: string
  /** 0..1 values, chronological; null = no data for that point. */
  values: (number | null)[]
}

const PAD = { l: 36, r: 64, t: 10, b: 22 }
const H = 200

/** Small multi-series line chart on a shared 0–100% axis, with crosshair tooltip. */
export function TrendChart({ series, xLabels }: { series: Series[]; xLabels: string[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(600)
  const [hover, setHover] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])

  const n = xLabels.length
  const plotW = Math.max(60, w - PAD.l - PAD.r)
  const plotH = H - PAD.t - PAD.b
  const x = (i: number) => PAD.l + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW)
  const y = (v: number) => PAD.t + (1 - v) * plotH

  const path = (vals: (number | null)[]) => {
    let d = ''
    let pen = false
    vals.forEach((v, i) => {
      if (v === null) return void (pen = false)
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`
      pen = true
    })
    return d
  }

  // Direct end labels, nudged apart so they never collide.
  const ends = series
    .map((s) => {
      const i = s.values.findLastIndex((v) => v !== null)
      return i < 0 ? null : { s, v: s.values[i] as number, yy: y(s.values[i] as number) }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)
    .sort((a, b) => a.yy - b.yy)
  for (let i = 1; i < ends.length; i++) if (ends[i].yy - ends[i - 1].yy < 14) ends[i].yy = ends[i - 1].yy + 14

  const onMove = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect()
    if (!r || n === 0) return
    const i = Math.round(((clientX - r.left - PAD.l) / plotW) * (n - 1))
    setHover(i >= 0 && i < n ? i : null)
  }

  return (
    <div>
      <div ref={ref} className="relative touch-pan-y" onPointerMove={(e) => onMove(e.clientX)} onPointerDown={(e) => onMove(e.clientX)} onPointerLeave={() => setHover(null)}>
        <svg width={w} height={H} role="img" className="block">
          {[0, 0.5, 0.9, 1].map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={PAD.l + plotW} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeDasharray={v === 0.9 ? '4 4' : undefined} />
              <text x={PAD.l - 6} y={y(v) + 4} textAnchor="end" fontSize={11} fill="var(--ink-3)">
                {Math.round(v * 100)}%
              </text>
            </g>
          ))}
          {series.map((s) => (
            <path key={s.key} d={path(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {n <= 12 &&
            series.map((s) =>
              s.values.map((v, i) => (v === null ? null : <circle key={`${s.key}${i}`} cx={x(i)} cy={y(v)} r={3} fill={s.color} stroke="var(--surface)" strokeWidth={1.5} />)),
            )}
          {ends.map((e) => (
            <text key={e.s.key} x={PAD.l + plotW + 6} y={e.yy + 4} fontSize={11} fill="var(--ink-2)">
              {e.s.label.length > 8 ? `${Math.round(e.v * 100)}%` : `${e.s.label} ${Math.round(e.v * 100)}%`}
            </text>
          ))}
          {hover !== null && (
            <>
              <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={PAD.t + plotH} stroke="var(--ink-3)" />
              {series.map((s) => {
                const v = s.values[hover]
                return v === null ? null : <circle key={s.key} cx={x(hover)} cy={y(v)} r={5} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
              })}
            </>
          )}
          <text x={PAD.l} y={H - 4} fontSize={11} fill="var(--ink-3)">
            {xLabels[0]}
          </text>
          <text x={PAD.l + plotW} y={H - 4} fontSize={11} fill="var(--ink-3)" textAnchor="end">
            {xLabels[n - 1]}
          </text>
        </svg>
        {hover !== null && (
          <div
            className="pointer-events-none absolute top-0 z-10 w-max rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs shadow-lg"
            style={{ left: Math.min(x(hover) + 10, Math.max(0, w - 150)) }}
          >
            <div className="mb-0.5 font-medium text-ink">{xLabels[hover]}</div>
            {series.map((s) => (
              <div key={s.key} className="flex items-center gap-1.5 text-ink-2">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
                {s.label}: <span className="text-ink tabular-nums">{s.values[hover] === null ? '—' : `${Math.round((s.values[hover] as number) * 100)}%`}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 rounded" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  )
}
