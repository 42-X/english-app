import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState } from 'react'
import { useAppState } from '../../app/state'
import { recentAttempts } from '../../data/repo'
import { groupBy, groupStats, isHiwAttempt, speedAdvice, THRESHOLDS, trapStats, type GroupStats } from '../../domain/adaptive'
import { speedCoaching } from '../../domain/coaching'
import { rollingDiagnosis } from '../../domain/report'
import { listeningStats } from '../../domain/listening'
import { recentListening } from '../../data/repo'
import { Link } from 'react-router-dom'
import type { Attempt, Confidence } from '../../domain/types'
import { useCoachText, useI18n } from '../../i18n'
import { pct, secs, signed, speedLabel } from '../../ui/format'
import { Card, CoachLine, PageHeader, Segmented, Stat } from '../../ui/kit'
import { TrendChart } from './TrendChart'

const WINDOWS = [10, 25, 50] as const

export function ProgressPage() {
  const { t, tk } = useI18n()
  const coach = useCoachText()
  const { settings, exerciseById } = useAppState()
  const [win, setWin] = useState<(typeof WINDOWS)[number]>(10)
  const all = useLiveQuery(() => recentAttempts(), [], [])
  const recent = all.slice(0, win)
  const previousWindow = all.slice(win, win * 2)
  const hiw = recent.filter(isHiwAttempt)
  const g = groupStats(hiw)
  const tracked = groupStats(recent)

  const trend = useMemo(() => {
    const chrono = [...recent].reverse()
    const roll = (f: (a: Attempt) => number | null) =>
      chrono.map((_, i) => {
        const vals = chrono
          .slice(Math.max(0, i - 2), i + 1)
          .map(f)
          .filter((v): v is number => v !== null)
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
      })
    return {
      labels: chrono.map((a) => new Date(a.completedAt).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })),
      precision: roll((a) => (isHiwAttempt(a) ? a.summary.score.precision : null)),
      recall: roll((a) => (isHiwAttempt(a) ? a.summary.score.recall : null)),
      sync: roll((a) => a.summary.sync?.within2 ?? null),
    }
  }, [recent])

  if (all.length === 0) {
    return (
      <div className="space-y-4">
        <PageHeader title={t('progress.title')} />
        <Card>
          <p className="text-sm text-ink-2">{t('progress.empty')}</p>
        </Card>
      </div>
    )
  }

  const traps = trapStats(hiw)
  const diagnosis = rollingDiagnosis(recent, previousWindow, exerciseById)
  const advice = speedCoaching(speedAdvice(all, settings.speed))
  const at1 = all.filter((a) => isHiwAttempt(a) && a.speed === 1 && a.mode !== 'overclick').slice(0, 20)
  const r1 = groupStats(at1)
  const fpPerEx = g.n ? g.falsePositives / g.n : null

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('progress.title')}
        action={<Segmented value={win} onChange={setWin} options={WINDOWS.map((n) => ({ value: n, label: t('progress.last', { n }) }))} />}
      />

      {diagnosis.length > 0 && (
        <Card title={t('diag.title')}>
          <div className="space-y-2">
            {diagnosis.map((l, i) => (
              <CoachLine key={i} tone={l.tone}>
                {coach(l.key, l.params)}
              </CoachLine>
            ))}
          </div>
          {previousWindow.length > 0 && <p className="mt-2 text-xs text-ink-3">{t('diag.trendNote')}</p>}
        </Card>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label={t('progress.avgNet')} value={g.n ? g.avgNet.toFixed(1) : '—'} />
        <Stat label={t('progress.precision')} value={pct(g.precision)} tone={tone(g.precision, THRESHOLDS.precision)} sub={t('progress.target', { v: pct(THRESHOLDS.precision) })} />
        <Stat label={t('progress.recall')} value={pct(g.recall)} tone={tone(g.recall, THRESHOLDS.recall)} sub={t('progress.target', { v: pct(THRESHOLDS.recall) })} />
        <Stat label={t('progress.fpRate')} value={fpPerEx === null ? '—' : fpPerEx.toFixed(1)} tone={fpPerEx === null ? undefined : fpPerEx <= 0.3 ? 'good' : 'warn'} />
        <Stat label={t('progress.sync')} value={pct(tracked.within2)} tone={tone(tracked.within2, THRESHOLDS.within2)} sub={t('progress.target', { v: pct(THRESHOLDS.within2) })} />
        <Stat label={t('progress.lag')} value={signed(tracked.avgLag)} />
        <Stat label={t('progress.recovery')} value={secs(tracked.avgRecoveryMs)} />
        <Stat label={t('progress.latency')} value={secs(g.avgLatencyMs)} />
        <Stat label={t('progress.lossRate')} value={tracked.n ? tracked.lossEventsPerAttempt.toFixed(1) : '—'} tone={tracked.lossEventsPerAttempt > 1 ? 'warn' : undefined} />
      </div>

      {recent.length >= 2 && (
        <Card title={t('progress.trend')}>
          <TrendChart
            xLabels={trend.labels}
            series={[
              { key: 'precision', label: t('progress.precision'), color: 'var(--series-1)', values: trend.precision },
              { key: 'recall', label: t('progress.recall'), color: 'var(--series-2)', values: trend.recall },
              { key: 'sync', label: t('progress.sync'), color: 'var(--series-3)', values: trend.sync },
            ]}
          />
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card title={t('progress.readiness')}>
          <ul className="space-y-2 text-sm">
            <Check label={t('progress.precision')} value={r1.precision} target={THRESHOLDS.precision} />
            <Check label={t('progress.recall')} value={r1.recall} target={THRESHOLDS.recall} />
            <Check label={t('progress.sync')} value={r1.within2} target={THRESHOLDS.within2} />
            <li className="flex justify-between text-ink-2">
              <span>{t('progress.col.n')} @ 1.0×</span>
              <span className={`tabular-nums ${r1.n >= 20 ? 'text-good' : ''}`}>{r1.n} / 20</span>
            </li>
          </ul>
          <p className="mt-3 text-xs text-ink-3">{t('progress.readinessNote')}</p>
        </Card>

        <Card title={t('progress.byTrap')}>
          {traps.length === 0 ? (
            <p className="text-sm text-ink-3">—</p>
          ) : (
            <ul className="space-y-2">
              {traps.slice(0, 10).map((s) => (
                <li key={s.category} className="grid grid-cols-[7.5rem_1fr_auto] items-center gap-2 text-sm">
                  <span className="truncate text-ink-2">{tk(`trap.${s.category}`)}</span>
                  <span className="h-2 overflow-hidden rounded bg-surface-2" role="presentation">
                    <span className="block h-full rounded bg-[var(--series-1)]" style={{ width: `${Math.max(2, s.missRate * 100)}%` }} />
                  </span>
                  <span className="text-xs text-ink-2 tabular-nums">
                    {pct(s.missRate)} <span className="text-ink-3">({t('progress.missedOf', { m: s.misses, t: s.total })})</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title={t('progress.speedExperiment')}>
        <p className="mb-3 text-sm text-ink-2">{t('progress.speedExperimentNote')}</p>
        <CoachLine tone={advice.tone}>{coach(advice.key, advice.params)}</CoachLine>
        <BreakdownTable
          head={t('progress.col.speed')}
          rows={[...groupBy(all.filter(isHiwAttempt), (a) => a.speed).entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [speedLabel(k), v])}
        />
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title={t('progress.byMode')}>
          <BreakdownTable head={t('progress.col.mode')} rows={[...groupBy(recent, (a) => a.mode).entries()].map(([k, v]) => [tk(`mode.${k}`), v])} />
        </Card>
        <Card title={t('progress.byAccent')}>
          <BreakdownTable head={t('progress.col.accent')} rows={[...groupBy(hiw, (a) => a.summary.accent).entries()].map(([k, v]) => [k, v])} />
        </Card>
      </div>

      <ListeningCard />

      <ConfidenceCard attempts={all} />
    </div>
  )
}

function tone(v: number | null, target: number): 'good' | 'warn' | 'bad' | undefined {
  if (v === null) return undefined
  return v >= target ? 'good' : v >= target - 0.1 ? 'warn' : 'bad'
}

function Check({ label, value, target }: { label: string; value: number | null; target: number }) {
  const ok = value !== null && value >= target
  return (
    <li className="flex items-center justify-between">
      <span className="text-ink-2">
        <span className={ok ? 'text-good' : 'text-ink-3'}>{ok ? '✓' : '○'}</span> {label}
      </span>
      <span className="tabular-nums text-ink">
        {pct(value)} <span className="text-xs text-ink-3">/ {pct(target)}</span>
      </span>
    </li>
  )
}

function BreakdownTable({ head, rows }: { head: string; rows: [string, GroupStats][] }) {
  const { t } = useI18n()
  if (!rows.length) return <p className="text-sm text-ink-3">—</p>
  return (
    <div className="-mx-1 mt-3 overflow-x-auto">
      <table className="w-full text-sm tabular-nums">
        <thead>
          <tr className="text-left text-xs text-ink-3">
            <th className="px-1 py-1.5 font-medium">{head}</th>
            <th className="px-1 py-1.5 text-right font-medium">{t('progress.col.n')}</th>
            <th className="px-1 py-1.5 text-right font-medium">{t('progress.precision')}</th>
            <th className="px-1 py-1.5 text-right font-medium">{t('progress.recall')}</th>
            <th className="px-1 py-1.5 text-right font-medium">{t('progress.sync')}</th>
            <th className="px-1 py-1.5 text-right font-medium">{t('progress.avgNet')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map(([k, s]) => (
            <tr key={k}>
              <td className="px-1 py-1.5 text-ink">{k}</td>
              <td className="px-1 py-1.5 text-right text-ink-2">{s.n}</td>
              <td className="px-1 py-1.5 text-right">{pct(s.precision)}</td>
              <td className="px-1 py-1.5 text-right">{pct(s.recall)}</td>
              <td className="px-1 py-1.5 text-right">{pct(s.within2)}</td>
              <td className="px-1 py-1.5 text-right">{s.avgNet.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ConfidenceCard({ attempts }: { attempts: Attempt[] }) {
  const { t } = useI18n()
  const { exerciseById } = useAppState()
  const stats = new Map<Confidence, { hits: number; total: number }>() // total labelled, hits = real mismatches
  for (const a of attempts) {
    const ex = exerciseById.get(a.exerciseId)
    if (!ex) continue
    for (const [idx, c] of Object.entries(a.confidence ?? {})) {
      const s = stats.get(c) ?? { hits: 0, total: 0 }
      s.total++
      if (ex.tokens[Number(idx)]?.isIncorrect) s.hits++
      stats.set(c, s)
    }
  }
  if (stats.size === 0) return null
  return (
    <Card title={t('progress.confidence')}>
      <div className="grid grid-cols-3 gap-2">
        {(['high', 'medium', 'guess'] as const).map((c) => {
          const s = stats.get(c)
          return (
            <Stat
              key={c}
              label={t(`results.conf.${c}`)}
              value={s ? pct(s.hits / s.total) : '—'}
              sub={s ? `n=${s.total} · ${t('progress.fpByConf', { n: s.total - s.hits })}` : undefined}
              tone={s && s.total - s.hits > s.hits ? 'warn' : undefined}
            />
          )
        })}
      </div>
    </Card>
  )
}

const LISTENING_TARGETS = { fibl: 0.8, wfd: 0.85 } as const

/** FIB-L and WFD: accuracy over the last 10 of each, where points go, most-missed words. */
function ListeningCard() {
  const { t, tk } = useI18n()
  const all = useLiveQuery(() => recentListening(undefined, 200), [], [])
  if (all.length === 0) {
    return (
      <Card title={t('lst.progressTitle')}>
        <p className="text-sm text-ink-2">{t('lst.progressEmpty')}</p>
        <div className="mt-3 flex gap-2">
          <Link className="text-sm text-accent underline" to="/practice?task=fibl">
            Fill in the Blanks →
          </Link>
          <Link className="text-sm text-accent underline" to="/practice?task=wfd">
            Write From Dictation →
          </Link>
        </div>
      </Card>
    )
  }
  const recent = [...all.filter((a) => a.task === 'fibl').slice(0, 10), ...all.filter((a) => a.task === 'wfd').slice(0, 10)]
  const s = listeningStats(recent)
  const lost = s.kinds.ending + s.kinds.spelling + s.kinds.wrong + s.kinds.blank
  return (
    <Card title={t('lst.progressTitle')}>
      <div className="grid grid-cols-2 gap-2">
        <Stat
          label="Fill in the Blanks"
          value={pct(s.fibl.accuracy)}
          tone={tone(s.fibl.accuracy, LISTENING_TARGETS.fibl)}
          sub={t('lst.targetSub', { v: pct(LISTENING_TARGETS.fibl), n: s.fibl.attempts })}
        />
        <Stat
          label="Write From Dictation"
          value={pct(s.wfd.accuracy)}
          tone={tone(s.wfd.accuracy, LISTENING_TARGETS.wfd)}
          sub={t('lst.targetSub', { v: pct(LISTENING_TARGETS.wfd), n: s.wfd.attempts })}
        />
      </div>
      {lost > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-xs font-medium text-ink-3">{t('lst.whereLost')}</div>
          <ul className="space-y-2">
            {(['ending', 'spelling', 'wrong', 'blank'] as const).map((k) => (
              <li key={k} className="grid grid-cols-[8rem_1fr_auto] items-center gap-2 text-sm">
                <span className="truncate text-ink-2">{tk(`lst.kind.${k}`)}</span>
                <span className="h-2 overflow-hidden rounded bg-surface-2" role="presentation">
                  <span className="block h-full rounded bg-[var(--series-2)]" style={{ width: `${(s.kinds[k] / lost) * 100}%` }} />
                </span>
                <span className="text-xs text-ink-2 tabular-nums">{s.kinds[k]}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {s.topWords.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-xs font-medium text-ink-3">{t('lst.topWords')}</div>
          <div className="flex flex-wrap gap-1.5">
            {s.topWords.map((w) => (
              <span key={w.word} className="rounded-md bg-surface-2 px-2 py-0.5 text-xs text-ink">
                {w.word}
                {w.count > 1 && <span className="ml-1 text-ink-3">×{w.count}</span>}
              </span>
            ))}
          </div>
          <Link className="mt-3 inline-block text-sm text-accent underline" to="/review/quick">
            {t('mistakes.quickReview')} →
          </Link>
        </div>
      )}
      <p className="mt-3 text-xs text-ink-3">{t('lst.targetNote')}</p>
    </Card>
  )
}
