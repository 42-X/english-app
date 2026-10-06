import { useLiveQuery } from 'dexie-react-hooks'
import { Link, useParams } from 'react-router-dom'
import { useAppState } from '../../app/state'
import { db } from '../../data/db'
import { recentAttempts, sessionAttempts } from '../../data/repo'
import { focusCoaching } from '../../domain/coaching'
import { overclickReport, sessionSummary, type Delta, type PointLoss } from '../../domain/report'
import type { Attempt, DailyPlan, ListeningAttempt } from '../../domain/types'
import { listeningStats } from '../../domain/listening'
import { useCoachText, useI18n } from '../../i18n'
import { pct } from '../../ui/format'
import { ButtonLink, Card, CoachLine, PageHeader, Stat } from '../../ui/kit'

const DAY = 86_400_000

export function ReportPage() {
  const { id = '' } = useParams()
  const { t } = useI18n()
  const data = useLiveQuery(async () => {
    const plan = await db.plans.get(id)
    if (!plan) return null
    const attempts = await sessionAttempts(plan)
    const recent = await recentAttempts(200)
    const listening = (await db.listening.bulkGet(plan.items.filter((i) => i.task === 'fibl' || i.task === 'wfd').map((i) => i.attemptId ?? '')))
      .filter((a): a is NonNullable<typeof a> => !!a && !a.deleted)
    return { plan, attempts, recent, listening }
  }, [id])
  if (data === undefined) return <p className="p-6 text-ink-2">{t('common.loading')}</p>
  if (data === null) return <p className="p-6 text-ink-2">{t('player.notFound')}</p>
  return data.plan.kind === 'overclick-test' ? <OverclickTestReport {...data} /> : <DailySummary {...data} />
}

interface Props {
  plan: DailyPlan
  attempts: Attempt[]
  recent: Attempt[]
  listening: ListeningAttempt[]
}

function OverclickTestReport({ plan, attempts }: Props) {
  const { t, tk } = useI18n()
  const { exerciseById } = useAppState()
  const r = overclickReport(attempts, exerciseById)
  const done = attempts.length
  return (
    <div className="space-y-4">
      <PageHeader title={t('report.oc.title')} sub={t('report.oc.sub', { done, total: plan.items.length })} />
      <Card>
        <div className="text-xs font-medium tracking-wide text-ink-3 uppercase">{t('report.oc.verdict')}</div>
        <div className={`mt-1 text-xl font-semibold ${r.profile === 'balanced' ? 'text-good' : 'text-ink'}`}>{tk(`report.profile.${r.profile}`)}</div>
        <p className="mt-2 text-sm leading-relaxed text-ink-2">{tk(`report.profileWhy.${r.profile}`)}</p>
        <CoachLine tone={r.profile === 'balanced' ? 'good' : 'warn'}>{tk(`report.profileDo.${r.profile}`)}</CoachLine>
      </Card>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label={t('report.oc.falseClicks')} value={r.falseClicks} tone={r.falseClicks ? 'bad' : 'good'} sub={t('report.oc.pointsLost', { n: r.pointsLost })} />
        <Stat label={t('report.oc.onClean')} value={r.clicksOnZero} tone={r.clicksOnZero ? 'bad' : 'good'} sub={t('report.oc.cleanPassages', { n: r.zeroPassages })} />
        <Stat label={t('results.precision')} value={pct(r.precision)} />
        <Stat label={t('results.recall')} value={pct(r.recall)} sub={`${r.hits}/${r.mismatches}`} />
      </div>
      <Card title={t('report.perPassage')}>
        <ul className="divide-y divide-line text-sm">
          {attempts.map((a, i) => {
            const ex = exerciseById.get(a.exerciseId)
            return (
              <li key={a.id} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0 truncate text-ink">
                  {i + 1}. {ex?.title}
                </span>
                <span className="shrink-0 text-xs text-ink-2 tabular-nums">
                  {t('report.oc.row', { mm: a.summary.score.mismatches, hits: a.summary.score.hits, fp: a.summary.score.falsePositives })}
                </span>
                <Link className="shrink-0 text-xs text-accent hover:underline" to={`/results/${a.id}`}>
                  {t('results.title')}
                </Link>
              </li>
            )
          })}
        </ul>
      </Card>
      <div className="flex gap-2">
        <ButtonLink variant="primary" to="/">
          {t('results.backToPlan')}
        </ButtonLink>
        <ButtonLink to="/progress">{t('nav.progress')}</ButtonLink>
      </div>
    </div>
  )
}

function DailySummary({ plan, attempts, recent, listening }: Props) {
  const { t, tk } = useI18n()
  const coach = useCoachText()
  const { exerciseById } = useAppState()
  const start = new Date(`${plan.date}T00:00:00`).getTime()
  const previous = recent.filter((a) => a.completedAt < start && a.completedAt >= start - 7 * DAY)
  const s = sessionSummary(attempts, previous, recent, exerciseById)
  return (
    <div className="space-y-4">
      <PageHeader title={t('report.day.title')} sub={t('report.day.sub', { n: s.attempts, net: s.net, max: s.maxNet })} />

      <Card title={t('report.day.improved')}>
        {s.improved.length === 0 && s.worse.length === 0 ? (
          <p className="text-sm text-ink-2">{previous.length ? t('report.day.steady') : t('report.day.firstDay')}</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {s.improved.map((d) => (
              <DeltaLine key={d.metric} d={d} good />
            ))}
            {s.worse.map((d) => (
              <DeltaLine key={d.metric} d={d} />
            ))}
          </ul>
        )}
      </Card>

      <Card title={t('report.day.lost')}>
        {s.losses.length === 0 ? (
          <p className="text-sm text-good">{t('report.day.noLoss')}</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {s.losses.map((l) => (
              <LossLine key={l.source} l={l} />
            ))}
          </ul>
        )}
      </Card>

      {listening.length > 0 && <ListeningSummary listening={listening} />}

      <Card title={t('report.day.tomorrow')}>
        <div className="space-y-2">
          {s.tomorrow.map((f, i) => {
            const c = focusCoaching(f)
            return (
              <CoachLine key={i} tone={c.tone}>
                {coach(c.key, c.params)}
              </CoachLine>
            )
          })}
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label={t('results.precision')} value={pct(s.stats.precision)} />
        <Stat label={t('results.recall')} value={pct(s.stats.recall)} />
        <Stat label={t('progress.sync')} value={pct(s.stats.within2)} />
        <Stat label={t('results.fps')} value={s.stats.falsePositives} />
      </div>
      <p className="text-xs text-ink-3">{tk('report.day.note')}</p>
      <ButtonLink variant="primary" to="/">
        {t('results.backToPlan')}
      </ButtonLink>
    </div>
  )
}

function DeltaLine({ d, good }: { d: Delta; good?: boolean }) {
  const { tk } = useI18n()
  const fmt = (v: number) => (d.metric === 'fpPerPassage' ? v.toFixed(1) : pct(v))
  return (
    <li className="flex items-center gap-2">
      <span className={good ? 'text-good' : 'text-bad'}>{good ? '▲' : '▼'}</span>
      <span className="text-ink">{tk(`report.metric.${d.metric}`)}</span>
      <span className="text-ink-2 tabular-nums">
        {fmt(d.before)} → {fmt(d.now)}
      </span>
    </li>
  )
}

function LossLine({ l }: { l: PointLoss }) {
  const { tk } = useI18n()
  const [kind, cat] = l.source.split(':')
  const label = kind === 'trap' ? tk('report.loss.trap', { cat: tk(`trap.${cat}`) }) : tk(`report.loss.${kind}`)
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="text-ink">{label}</span>
      <span className="font-medium text-bad tabular-nums">−{l.points}</span>
    </li>
  )
}

function ListeningSummary({ listening }: { listening: ListeningAttempt[] }) {
  const { t, tk } = useI18n()
  const s = listeningStats(listening)
  const worst = (['ending', 'spelling', 'wrong', 'blank'] as const).filter((k) => s.kinds[k] > 0).sort((a, b) => s.kinds[b] - s.kinds[a])
  return (
    <Card title={t('lst.progressTitle')}>
      <div className="grid grid-cols-2 gap-2">
        {s.fibl.attempts > 0 && <Stat label="Fill in the Blanks" value={`${s.fibl.correct}/${s.fibl.total}`} sub={pct(s.fibl.accuracy)} />}
        {s.wfd.attempts > 0 && <Stat label="Write From Dictation" value={`${s.wfd.correct}/${s.wfd.total}`} sub={pct(s.wfd.accuracy)} />}
      </div>
      {worst[0] && <CoachLine tone="warn">{tk(`lst.${worst[0]}${worst[0] === 'blank' ? '.fibl' : ''}`, { n: s.kinds[worst[0]] })}</CoachLine>}
    </Card>
  )
}
