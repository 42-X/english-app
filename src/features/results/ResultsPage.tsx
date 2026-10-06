import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo } from 'react'
import { useParams } from 'react-router-dom'
import { useAppState } from '../../app/state'
import { playSnippet, stopSnippet } from '../../audio/engine'
import { db } from '../../data/db'
import { updateConfidence } from '../../data/repo'
import { requestSync } from '../../data/sync'
import { falsePositiveRows, mismatchRows, type Cause } from '../../domain/analysis'
import { attemptCoaching } from '../../domain/coaching'
import { blackoutRecoveries } from '../../domain/sync'
import type { Attempt, Confidence, Exercise, Token } from '../../domain/types'
import { useCoachText, useI18n } from '../../i18n'
import { pct, secs, signed, speedLabel } from '../../ui/format'
import { Badge, Button, ButtonLink, Card, CoachLine, Stat } from '../../ui/kit'
import { Timeline } from './Timeline'

export function ResultsPage() {
  const { id = '' } = useParams()
  const attempt = useLiveQuery(() => db.attempts.get(id), [id])
  const { exerciseById, ready } = useAppState()
  const { t } = useI18n()
  if (attempt === undefined || !ready) return <p className="p-6 text-ink-2">{t('common.loading')}</p>
  const ex = exerciseById.get(attempt.exerciseId)
  if (!ex) return <p className="p-6 text-ink-2">{t('player.notFound')}</p>
  return <Results attempt={attempt} ex={ex} />
}

function Results({ attempt, ex }: { attempt: Attempt; ex: Exercise }) {
  const { t, tk } = useI18n()
  const coach = useCoachText()
  const s = attempt.summary
  const guided = attempt.mode === 'guided'
  const rows = useMemo(() => mismatchRows(ex, attempt), [ex, attempt])
  const fps = useMemo(() => falsePositiveRows(ex, attempt), [ex, attempt])
  const lines = attemptCoaching(s, rows, fps, attempt.confidence, guided)
  const recoveries = blackoutRecoveries(attempt.samples, attempt.blackouts, attempt.speed)
  const approx = attempt.timing !== 'exact'

  useEffect(() => stopSnippet, [])

  const plan = useLiveQuery(() => (attempt.planId ? db.plans.get(attempt.planId) : undefined), [attempt.planId])
  const nextItem = plan?.items.find((i) => !i.attemptId)

  const setConf = (index: number, c: Confidence) => {
    const next = { ...attempt.confidence }
    if (next[index] === c) delete next[index]
    else next[index] = c
    void updateConfidence(attempt.id, next).then(requestSync)
  }

  const sel = new Set(attempt.selected)
  const decorate = (tok: Token) => {
    if (tok.isIncorrect) return sel.has(tok.index) ? 'word-hit' : 'word-miss'
    if (sel.has(tok.index)) return 'word-fp'
    return undefined
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 px-4 py-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-ink-3">
            {tk(`mode.${attempt.mode}`)} · {speedLabel(attempt.speed)} · {ex.accent}
          </p>
          <h1 className="text-xl font-semibold text-ink">{ex.title}</h1>
        </div>
        {approx && <Badge tone="warn">{t('common.approx')}</Badge>}
      </header>

      {!guided && (
        <Card>
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <div>
              <div className="text-xs text-ink-3">{t('results.net')}</div>
              <div className="text-4xl font-semibold tabular-nums text-ink">
                {s.score.net}
                <span className="text-xl text-ink-3"> / {s.score.mismatches}</span>
              </div>
            </div>
            <div className="grid flex-1 grid-cols-3 gap-2 sm:grid-cols-6">
              <Stat label={t('results.hits')} value={s.score.hits} tone={s.score.hits === s.score.mismatches ? 'good' : undefined} />
              <Stat label={t('results.fps')} value={s.score.falsePositives} tone={s.score.falsePositives ? 'bad' : 'good'} />
              <Stat label={t('results.misses')} value={s.score.misses} tone={s.score.misses ? 'warn' : undefined} />
              <Stat label={t('results.precision')} value={pct(s.score.precision)} />
              <Stat label={t('results.recall')} value={pct(s.score.recall)} />
              <Stat label={t('results.latency')} value={secs(s.avgLatencyMs)} />
            </div>
          </div>
          <p className="mt-3 text-xs text-ink-3">{t('results.simulation')}</p>
        </Card>
      )}

      <Card>
        <div className="space-y-2">
          {guided && <CoachLine tone="info">{t('results.guidedOnly')}</CoachLine>}
          {lines.map((l, i) => (
            <CoachLine key={i} tone={l.tone}>
              {coach(l.key, l.params)}
            </CoachLine>
          ))}
        </div>
      </Card>

      <Card title={t('results.syncTitle')} action={approx ? <span className="text-xs text-warn">{t('common.approxNote')}</span> : undefined}>
        {s.sync ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label={t('results.within1')} value={pct(s.sync.within1)} />
            <Stat label={t('results.within2')} value={pct(s.sync.within2)} tone={s.sync.within2 >= 0.9 ? 'good' : s.sync.within2 < 0.75 ? 'bad' : 'warn'} />
            <Stat label={t('results.avgLag')} value={t('results.lagWords', { n: signed(s.sync.avgLag) })} sub={`median ${signed(s.sync.medianLag)}`} />
            <Stat label={t('results.maxBehind')} value={t('results.lagWords', { n: s.sync.maxBehind })} />
            <Stat label={t('results.lossEvents')} value={s.sync.lossEvents} tone={s.sync.lossEvents ? 'warn' : 'good'} />
            <Stat label={t('results.avgRecovery')} value={secs(s.sync.avgRecoveryMs)} />
            <Stat label={t('results.longestRecovery')} value={secs(s.sync.longestRecoveryMs)} />
            <Stat label={t('results.coverage')} value={pct(s.sync.coverage)} />
          </div>
        ) : (
          <p className="text-sm text-ink-2">{t('coach.noTracking')}</p>
        )}
        {attempt.blackouts.length > 0 && (
          <p className="mt-3 text-sm text-ink-2">
            {t('results.blackouts', { list: recoveries.map((r) => (r === null ? t('results.notRecovered') : secs(r))).join(' · ') })}
          </p>
        )}
      </Card>

      <Card title={t('results.timeline')}>
        <Timeline
          samples={attempt.samples}
          durationMs={ex.durationMs}
          rows={guided ? [] : rows}
          fps={guided ? [] : fps}
          interactions={attempt.interactions}
          blackouts={attempt.blackouts}
        />
      </Card>

      {!guided && rows.length > 0 && (
        <Card title={t('results.mismatches')}>
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.token.index} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                <div className="min-w-40 flex-1">
                  <div className="text-base">
                    <span className="text-ink-3 line-through decoration-1">{r.token.displayText}</span>
                    <span className="mx-1.5 text-ink-3">→</span>
                    <span className="font-semibold text-ink">{r.token.spokenText}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {r.token.trapCategory && <Badge>{tk(`trap.${r.token.trapCategory}`)}</Badge>}
                    <CauseBadges causes={r.causes} />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <Badge tone={r.selected ? 'good' : 'bad'}>{r.selected ? t('results.hit') : t('results.miss')}</Badge>
                  <span className="text-ink-2 tabular-nums" title={t('results.col.latency')}>
                    {r.latencyMs !== null && r.bucket ? `${secs(r.latencyMs)} · ${tk(`latency.${r.bucket}`)}` : '—'}
                  </span>
                  <span className="text-ink-2" title={t('results.col.lag')}>
                    <LagText lag={r.lag} />
                  </span>
                </div>
                <Replay ex={ex} index={r.token.index} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      {!guided && (
        <Card title={t('results.fpTitle')}>
          {fps.length === 0 ? (
            <p className="text-sm text-good">{t('results.fpNone')}</p>
          ) : (
            <ul className="divide-y divide-line">
              {fps.map((f) => (
                <li key={f.token.index} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                  <div className="min-w-40 flex-1">
                    <div className="text-base font-medium text-ink">{f.token.displayText}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <CauseBadges causes={f.causes} />
                    </div>
                  </div>
                  <span className="text-sm text-ink-2">
                    <LagText lag={f.lag} />
                  </span>
                  <Replay ex={ex} index={f.token.index} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {!guided && attempt.selected.length > 0 && (
        <Card title={t('results.confidenceTitle')}>
          <p className="mb-3 text-sm text-ink-2">{t('results.confidenceHint')}</p>
          <ul className="space-y-2">
            {attempt.selected.map((i) => (
              <li key={i} className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-ink">{ex.tokens[i]?.displayText}</span>
                <div className="inline-flex gap-1">
                  {(['high', 'medium', 'guess'] as const).map((c) => (
                    <button
                      key={c}
                      onClick={() => setConf(i, c)}
                      className={`rounded-md border px-2.5 py-1 text-xs ${
                        attempt.confidence[i] === c ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-2 hover:bg-surface-2'
                      }`}
                    >
                      {t(`results.conf.${c}`)}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title={t('results.transcript')}>
        <ReviewTranscript ex={ex} decorate={guided ? () => undefined : decorate} />
      </Card>

      {ex.credit && (
        <p className="text-xs text-ink-3">
          {t('results.audioCredit')}: {ex.credit.work} — {ex.credit.author},{' '}
          {ex.credit.url ? (
            <a className="underline" href={ex.credit.url} target="_blank" rel="noreferrer">
              {ex.credit.license}
            </a>
          ) : (
            ex.credit.license
          )}
          . {ex.credit.note}
        </p>
      )}

      <div className="flex flex-wrap gap-2 pb-4">
        {nextItem ? (
          <ButtonLink variant="primary" to={`/play/${nextItem.exerciseId}?mode=${nextItem.mode}&speed=${nextItem.speed}&plan=${plan!.id}`} replace>
            {t('results.nextInPlan')} →
          </ButtonLink>
        ) : null}
        {plan && <ButtonLink to="/">{t('results.backToPlan')}</ButtonLink>}
        <ButtonLink to={`/play/${ex.id}?mode=${attempt.mode}&speed=${attempt.speed}`} replace>
          {t('results.retry')}
        </ButtonLink>
        {!plan && (
          <ButtonLink variant="primary" to="/practice">
            {t('results.morePractice')}
          </ButtonLink>
        )}
      </div>
    </div>
  )
}

function CauseBadges({ causes }: { causes: Cause[] }) {
  const { tk } = useI18n()
  return (
    <>
      {causes.map((c, i) => (
        <Badge key={c} tone={i === 0 ? 'warn' : 'neutral'}>
          {tk(`cause.${c}`)}
        </Badge>
      ))}
    </>
  )
}

function LagText({ lag }: { lag: number | null }) {
  const { t } = useI18n()
  if (lag === null) return <>—</>
  if (lag === 0) return <>{t('results.onWord')}</>
  const cls = Math.abs(lag) >= 5 ? 'text-bad' : Math.abs(lag) >= 3 ? 'text-warn' : ''
  return <span className={cls}>{lag < 0 ? t('results.behindWords', { n: -lag }) : t('results.aheadWords', { n: lag })}</span>
}

export function Replay({ ex, index }: { ex: Exercise; index: number }) {
  return (
    <div className="inline-flex gap-1" aria-label="replay">
      {[0.8, 1, 1.1].map((r) => (
        <Button key={r} className="px-2.5 py-1 text-xs" onClick={() => void playSnippet(ex, index, r)}>
          ▶ {r}×
        </Button>
      ))}
    </div>
  )
}

function ReviewTranscript({ ex, decorate }: { ex: Exercise; decorate: (t: Token) => string | undefined }) {
  return (
    <p className="transcript-training text-[1.05rem]! leading-[2.2]!">
      {ex.tokens.map((tok) => (
        <span key={tok.index}>
          {tok.leading}
          <span className={`word ${decorate(tok) ?? ''}`}>
            {tok.displayText}
            {tok.isIncorrect && <sup className="ml-0.5 text-[0.7em] text-ink-2">{tok.spokenText}</sup>}
          </span>
          {tok.trailing}{' '}
        </span>
      ))}
    </p>
  )
}
