import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useAppState } from '../../app/state'
import { playSnippet, stopSnippet } from '../../audio/engine'
import { db } from '../../data/db'
import { recentAttempts, updateConfidence } from '../../data/repo'
import { requestSync } from '../../data/sync'
import { falsePositiveRows, mismatchRows, type Cause } from '../../domain/analysis'
import { attemptCoaching } from '../../domain/coaching'
import { hiwMood } from '../../domain/momentum'
import { blackoutRecoveries } from '../../domain/sync'
import type { Attempt, Confidence, Exercise, Token } from '../../domain/types'
import { useCoachText, useI18n } from '../../i18n'
import { pct, secs, signed, speedLabel } from '../../ui/format'
import { Badge, Button, ButtonLink, Card, CoachLine, Disclosure, Stat } from '../../ui/kit'
import { playLink } from '../home/HomePage'
import { useKeepGoing } from '../home/keepGoing'
import { Timeline } from './Timeline'
import { WordSheet, type WordTarget } from '../vocab/WordSheet'
import { contextAround } from '../../domain/analysis'

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
  // One thing to work on: the most important non-praise line.
  const tip = lines.find((l) => l.tone === 'warn') ?? lines.find((l) => l.tone === 'info')
  const recoveries = blackoutRecoveries(attempt.samples, attempt.blackouts, attempt.speed)
  const approx = attempt.timing !== 'exact'
  const history = useLiveQuery(() => recentAttempts(40), [])
  const mood = history && hiwMood(attempt, history)

  useEffect(() => stopSnippet, [])
  const [wordTarget, setWordTarget] = useState<WordTarget | null>(null)
  /** Open the word sheet for the word actually spoken at this position. */
  const openWord = (tok: Token) =>
    setWordTarget({ word: tok.spokenText, exerciseId: ex.id, tokenIndex: tok.index, context: sentenceAround(ex, tok.index) })

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

      <Card>
        {guided ? (
          <div className="space-y-2">
            <CoachLine tone="info">{t('results.guidedOnly')}</CoachLine>
            {lines.map((l, i) => (
              <CoachLine key={i} tone={l.tone}>
                {coach(l.key, l.params)}
              </CoachLine>
            ))}
          </div>
        ) : (
          <>
            {mood && <div className="text-2xl font-semibold text-ink">{tk(`mood.${mood}`)}</div>}
            <p className="mt-1 text-sm text-ink-2">
              {s.score.mismatches ? t('results.caught', { hits: s.score.hits, mm: s.score.mismatches }) : t('results.caughtClean')}{' '}
              {s.score.falsePositives ? t('results.extraClicks', { n: s.score.falsePositives }) : t('results.noExtra')}
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label={t('results.caughtStat')} value={`${s.score.hits}/${s.score.mismatches}`} tone={s.score.hits > 0 ? 'good' : undefined} />
              <Stat label={t('results.extraStat')} value={s.score.falsePositives} tone={s.score.falsePositives ? 'warn' : 'good'} />
              <Stat label={t('results.toPractise')} value={s.score.misses + s.score.falsePositives} />
              <Stat label={t('results.net')} value={`${s.score.net}/${s.score.mismatches}`} />
            </div>
            {mood === 'tough' && <p className="mt-3 text-xs text-ink-3">{t('results.toughNote')}</p>}
            {tip && tip.tone !== 'good' && (
              <div className="mt-4 rounded-lg bg-accent-soft px-3 py-2.5">
                <div className="text-xs font-semibold text-accent">💡 {t('results.tipTitle')}</div>
                <p className="mt-0.5 text-sm leading-relaxed text-ink">{coach(tip.key, tip.params)}</p>
              </div>
            )}
          </>
        )}
        <NextActions attempt={attempt} className="mt-4" celebrate />
      </Card>

      {!guided && rows.length > 0 && (
        <Card title={t('results.wordsToReplay')}>
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
                  </div>
                </div>
                <Badge tone={r.selected ? 'good' : 'accent'}>{r.selected ? t('results.hit') : t('results.miss')}</Badge>
                <div className="flex items-center gap-1">
                  <Replay ex={ex} index={r.token.index} />
                  <Button className="px-2.5 py-1 text-xs" onClick={() => openWord(r.token)} aria-label={t('vocab.lookUp')} title={t('vocab.lookUp')}>
                    📖
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          {(s.score.misses > 0 || fps.length > 0) && <p className="mt-2 text-xs text-ink-3">{t('results.savedNote')}</p>}
        </Card>
      )}

      <Card title={t('results.transcript')}>
        <p className="mb-2 text-xs text-ink-3">{t('vocab.tapHint')}</p>
        <ReviewTranscript ex={ex} decorate={guided ? () => undefined : decorate} onWord={openWord} />
      </Card>

      <Disclosure title={t('results.details')}>
        {!guided && (
          <div className="space-y-2">
            {lines.map((l, i) => (
              <CoachLine key={i} tone={l.tone}>
                {coach(l.key, l.params)}
              </CoachLine>
            ))}
          </div>
        )}

        {!guided && (
          <div className="grid grid-cols-3 gap-2">
            <Stat label={t('results.precision')} value={pct(s.score.precision)} />
            <Stat label={t('results.recall')} value={pct(s.score.recall)} />
            <Stat label={t('results.latency')} value={secs(s.avgLatencyMs)} />
          </div>
        )}

        <section>
          <h3 className="mb-2 text-sm font-semibold text-ink">
            {t('results.syncTitle')}
            {approx && <span className="ml-2 text-xs font-normal text-warn">{t('common.approxNote')}</span>}
          </h3>
          {s.sync ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label={t('results.within1')} value={pct(s.sync.within1)} />
              <Stat label={t('results.within2')} value={pct(s.sync.within2)} tone={s.sync.within2 >= 0.9 ? 'good' : s.sync.within2 < 0.75 ? 'warn' : undefined} />
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
          {attempt.checks && attempt.checks.length > 0 && (
            <p className="mt-3 text-sm text-ink-2">
              {t('results.checks', {
                ok: attempt.checks.filter((c) => c.answer !== null && Math.abs(c.answer - c.spoken) <= 1).length,
                total: attempt.checks.length,
                off: (() => {
                  const answered = attempt.checks.filter((c) => c.answer !== null)
                  return answered.length ? (answered.reduce((n, c) => n + Math.abs((c.answer as number) - c.spoken), 0) / answered.length).toFixed(1) : '—'
                })(),
              })}
            </p>
          )}
          {attempt.blackouts.length > 0 && (
            <p className="mt-3 text-sm text-ink-2">
              {t('results.blackouts', { list: recoveries.map((r) => (r === null ? t('results.notRecovered') : secs(r))).join(' · ') })}
            </p>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-sm font-semibold text-ink">{t('results.timeline')}</h3>
          <Timeline
            samples={attempt.samples}
            durationMs={ex.durationMs}
            rows={guided ? [] : rows}
            fps={guided ? [] : fps}
            interactions={attempt.interactions}
            blackouts={attempt.blackouts}
          />
        </section>

        {!guided && rows.length > 0 && (
          <section>
            <h3 className="mb-2 text-sm font-semibold text-ink">{t('results.mismatches')}</h3>
            <ul className="divide-y divide-line">
              {rows.map((r) => (
                <li key={r.token.index} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-sm">
                  <span className="min-w-32 font-medium text-ink">{r.token.spokenText}</span>
                  <span className="flex flex-wrap gap-1">
                    <CauseBadges causes={r.causes} />
                  </span>
                  <span className="text-ink-2 tabular-nums" title={t('results.col.latency')}>
                    {r.latencyMs !== null && r.bucket ? `${secs(r.latencyMs)} · ${tk(`latency.${r.bucket}`)}` : '—'}
                  </span>
                  <span className="text-ink-2" title={t('results.col.lag')}>
                    <LagText lag={r.lag} />
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {!guided && (
          <section>
            <h3 className="mb-2 text-sm font-semibold text-ink">{t('results.fpTitle')}</h3>
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
          </section>
        )}

        {!guided && attempt.selected.length > 0 && (
          <section>
            <h3 className="mb-1 text-sm font-semibold text-ink">{t('results.confidenceTitle')}</h3>
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
          </section>
        )}
        {!guided && <p className="text-xs text-ink-3">{t('results.simulation')}</p>}
      </Disclosure>

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

      <NextActions attempt={attempt} className="pb-4" retryTo={`/play/${ex.id}?mode=${attempt.mode}&speed=${attempt.speed}`} />
      {wordTarget && <WordSheet target={wordTarget} onClose={() => setWordTarget(null)} />}
    </div>
  )
}

/**
 * Where to go from a result: the next plan item, or — when the plan is used up — straight into a
 * fresh bonus round, so practice never dead-ends on a score.
 */
export function NextActions({
  attempt,
  className = '',
  celebrate = false,
  retryTo,
}: {
  attempt: { planId?: string; id: string }
  className?: string
  /** Show the "quest complete" banner (once per page). */
  celebrate?: boolean
  retryTo?: string
}) {
  const { t } = useI18n()
  const keepGoing = useKeepGoing()
  const plan = useLiveQuery(() => (attempt.planId ? db.plans.get(attempt.planId) : undefined), [attempt.planId])
  const nextItem = plan?.items.find((i) => !i.attemptId)
  const quest = plan?.kind === 'overclick-test' ? [] : (plan?.items.filter((i) => !i.bonus) ?? [])
  const questDone = quest.length > 0 && quest.every((i) => i.attemptId) && quest.some((i) => i.attemptId === attempt.id)
  return (
    <div className={className}>
      {celebrate && questDone && !plan?.items.some((i) => i.bonus && i.attemptId) && (
        <p className="mb-3 rounded-lg bg-good-soft px-3 py-2.5 text-sm font-medium text-good">{t('home.allDone')}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {nextItem && plan ? (
          <ButtonLink variant="primary" to={playLink(nextItem, plan)} replace>
            {t('results.nextInPlan')} →
          </ButtonLink>
        ) : (
          <Button variant="primary" onClick={() => void keepGoing(true)}>
            {t('home.keepGoing')} →
          </Button>
        )}
        {questDone && plan && <ButtonLink to={`/report/${plan.id}`}>{t('report.day.open')}</ButtonLink>}
        {retryTo && (
          <ButtonLink to={retryTo} replace>
            {t('results.retry')}
          </ButtonLink>
        )}
        <ButtonLink to="/">{t('results.backToPlan')}</ButtonLink>
      </div>
    </div>
  )
}

function sentenceAround(ex: Exercise, index: number): string {
  // Expand to sentence boundaries (punctuation) within ±25 words, falling back to a short window.
  let a = index
  while (a > 0 && index - a < 25 && !/[.!?]/.test(ex.tokens[a - 1].trailing)) a--
  let b = index
  while (b < ex.tokens.length - 1 && b - index < 25 && !/[.!?]/.test(ex.tokens[b].trailing)) b++
  if (b - a > 40) return contextAround(ex.tokens, index, 8).replace(/[[\]]/g, '')
  return ex.tokens
    .slice(a, b + 1)
    .map((t) => `${t.leading}${t.spokenText}${t.trailing}`)
    .join(' ')
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

function ReviewTranscript({ ex, decorate, onWord }: { ex: Exercise; decorate: (t: Token) => string | undefined; onWord: (t: Token) => void }) {
  return (
    <p className="transcript-training text-[1.05rem]! leading-[2.2]!">
      {ex.tokens.map((tok) => (
        <span key={tok.index}>
          {tok.leading}
          <span
            role="button"
            tabIndex={0}
            onClick={() => onWord(tok)}
            onKeyDown={(e) => e.key === 'Enter' && onWord(tok)}
            className={`word cursor-pointer hover:underline ${decorate(tok) ?? ''}`}
          >
            {tok.displayText}
            {tok.isIncorrect && <sup className="ml-0.5 text-[0.7em] text-ink-2">{tok.spokenText}</sup>}
          </span>
          {tok.trailing}{' '}
        </span>
      ))}
    </p>
  )
}
