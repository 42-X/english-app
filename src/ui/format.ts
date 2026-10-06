export function pct(x: number | null | undefined, digits = 0): string {
  if (x === null || x === undefined || Number.isNaN(x)) return '—'
  return `${(x * 100).toFixed(digits)}%`
}

export function secs(ms: number | null | undefined, digits = 1): string {
  if (ms === null || ms === undefined) return '—'
  return `${(ms / 1000).toFixed(digits)}s`
}

export function signed(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined) return '—'
  const v = Number(n.toFixed(digits))
  return v > 0 ? `+${v}` : `${v}`
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function speedLabel(s: number): string {
  return `${Number(s.toFixed(2))}×`
}

export function relativeTime(ms: number, lang: string): string {
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' })
  const diff = ms - Date.now()
  const abs = Math.abs(diff)
  if (abs < 60_000) return rtf.format(Math.round(diff / 1000), 'second')
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute')
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), 'hour')
  return rtf.format(Math.round(diff / 86_400_000), 'day')
}

export function durationText(ms: number, lang: string): string {
  const zh = lang.startsWith('zh')
  if (ms < 3_600_000) {
    const m = Math.max(1, Math.round(ms / 60_000))
    return zh ? `${m} 分鐘` : `${m} min`
  }
  if (ms < 86_400_000) {
    const h = Math.round(ms / 3_600_000)
    return zh ? `${h} 小時` : `${h} h`
  }
  const d = Math.round(ms / 86_400_000)
  return zh ? `${d} 天` : `${d} d`
}
