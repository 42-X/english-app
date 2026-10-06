import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAppState } from '../../app/state'
import { db } from '../../data/db'
import { extendPlan, isOnboarded, liveMistakes, liveVocab, markOnboarded, recentAttempts, startOverclickTest, todaysPlan } from '../../data/repo'
import { requestSync } from '../../data/sync'
import { isHiwAttempt, speedAdvice, targetLevel, weaknesses } from '../../domain/adaptive'
import { focusCoaching, speedCoaching } from '../../domain/coaching'
import { estimatedMinutes, localDate } from '../../domain/plan'
import { isDue } from '../../domain/srs'
import type { DailyPlan, PlanItem } from '../../domain/types'
import { useCoachText, useI18n } from '../../i18n'
import { speedLabel } from '../../ui/format'
import { Button, ButtonLink, Card, CoachLine, PageHeader } from '../../ui/kit'

const BLOCKS: PlanItem['block'][] = ['warmup', 'drill', 'realistic', 'review']
/** Scored questions needed before the personal focus appears (mirrors `weaknesses`). */
const BASELINE = 3

export function HomePage() {
  const { exercises, exerciseById, settings, ready } = useAppState()
  const { t, tk, lang } = useI18n()
  const coach = useCoachText()
  const navigate = useNavigate()
  const [regen, setRegen] = useState(0)
  const [testError, setTestError] = useState(false)
  const date = localDate()

  const plan = useLiveQuery(async () => {
    const p = await db.plans.get(`plan-${date}`)
    return p && !p.deleted ? p : null
  }, [date])

  useEffect(() => {
    if (!ready || plan === undefined) return
    if (plan === null || regen > 0) {
      void todaysPlan(exercises, settings.speed, regen > 0).then(requestSync)
      if (regen > 0) setRegen(0)
    }
  }, [ready, plan, regen, exercises, settings.speed])

  const attempts = useLiveQuery(() => recentAttempts(60), [], [])
  const mistakes = useLiveQuery(() => liveMistakes(), [], [])
  const vocab = useLiveQuery(() => liveVocab(), [], [])
  const onboarded = useLiveQuery(() => isOnboarded(), [], true)
  const due = mistakes.filter((m) => isDue(m, Date.now())).length
  const advice = speedAdvice(attempts, settings.speed)
  const speedLine = speedCoaching(advice)
  const level = targetLevel(attempts)
  // Live, not frozen at plan creation: updates as soon as she finishes a question.
  const focus = weaknesses(attempts)
  const scored = attempts.filter(isHiwAttempt).length

  const startTest = async () => {
    const test = await startOverclickTest(exercises)
    if (!test) return setTestError(true)
    navigate(`${playLink(test.items[0], test)}&flow=test`)
  }

  if (!ready || !plan) return <p className="p-6 text-ink-2">{t('common.loading')}</p>

  const next = plan.items.find((i) => !i.attemptId)
  const nextEx = next ? exerciseById.get(next.exerciseId) : undefined
  const doneCount = plan.items.filter((i) => i.attemptId).length
  const dateLabel = new Date().toLocaleDateString(lang, { weekday: 'long', month: 'long', day: 'numeric' })

  return (
    <div className="space-y-4">
      <PageHeader title={t('home.title')} sub={`${dateLabel} · ${t('common.minutes', { n: estimatedMinutes(plan, exerciseById) })}`} />

      {!onboarded && (
        <Card title={t('home.howTitle')} action={<Button variant="ghost" onClick={() => void markOnboarded()}>{t('home.dismiss')}</Button>}>
          <ul className="space-y-1.5 text-sm text-ink-2">
            <li>🖱️ {t('home.howDesktop')}</li>
            <li>👆 {t('home.howMobile')}</li>
          </ul>
        </Card>
      )}

      {/* Progress + the one obvious next step */}
      <Card>
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium text-ink">{t('home.progress', { done: doneCount, total: plan.items.length })}</span>
          <span className="text-ink-3">
            {t('home.level')}: {tk(`home.level.${level}`)}
          </span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2">
          <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${(doneCount / Math.max(1, plan.items.length)) * 100}%` }} />
        </div>
        {next ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs text-ink-3">{t('home.upNext', { n: plan.items.indexOf(next) + 1 })}</div>
              <div className="truncate font-medium text-ink">
                {nextEx?.title} · <span className="text-ink-2">{tk(`mode.${next.mode}`)}</span>
              </div>
            </div>
            <ButtonLink variant="primary" className="py-2.5" to={playLink(next, plan)}>
              {doneCount ? t('common.continue') : t('home.startNext')} →
            </ButtonLink>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <CoachLine tone="good">{t('home.allDone')}</CoachLine>
            <div className="flex flex-wrap gap-2">
              <ButtonLink variant="primary" to={`/report/${plan.id}`}>
                {t('report.day.open')} →
              </ButtonLink>
              <Button onClick={() => void extendPlan(plan.id, exercises, settings.speed).then(requestSync)}>＋ {t('home.addMore')}</Button>
            </div>
          </div>
        )}
      </Card>

      <Card title={t('home.focusTitle')}>
        {focus[0]?.type === 'baseline' ? (
          <CoachLine tone="info">{t('home.baselineNeeded', { n: Math.max(1, BASELINE - scored) })}</CoachLine>
        ) : (
          <div className="space-y-2">
            {focus.length === 0 && <CoachLine tone="good">{t('home.noWeakness')}</CoachLine>}
            {focus.map((f, i) => {
              const c = focusCoaching(f)
              return (
                <CoachLine key={i} tone={c.tone}>
                  {coach(c.key, c.params)}
                </CoachLine>
              )
            })}
          </div>
        )}
      </Card>

      <div className="space-y-3">
        {BLOCKS.map((block) => {
          const items = plan.items.filter((i) => i.block === block)
          if (!items.length) return null
          return (
            <Card key={block} title={t(`home.block.${block}`)}>
              <p className="-mt-1 mb-2 text-xs text-ink-3">{t(`home.blockWhy.${block}`)}</p>
              <ol className="divide-y divide-line">
                {items.map((item, idx) => {
                  const ex = exerciseById.get(item.exerciseId)
                  const isNext = item === next
                  return (
                    <li key={idx} className="flex items-center gap-3 py-2.5">
                      <span
                        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${
                          item.attemptId ? 'bg-good-soft text-good' : isNext ? 'bg-accent text-on-accent' : 'bg-surface-2 text-ink-3'
                        }`}
                        aria-label={item.attemptId ? t('home.done') : undefined}
                      >
                        {item.attemptId ? '✓' : plan.items.indexOf(item) + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-ink">{ex?.title ?? item.exerciseId}</div>
                        <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
                          <span>{tk(`mode.${item.mode}`)}</span>
                          <span>· {speedLabel(item.speed)}</span>
                          <span>· {reasonText(item.reason, tk)}</span>
                        </div>
                      </div>
                      {item.attemptId ? (
                        <Link className="text-xs text-accent hover:underline" to={`/results/${item.attemptId}`}>
                          {t('results.title')}
                        </Link>
                      ) : (
                        <ButtonLink variant={isNext ? 'primary' : 'secondary'} className="px-3 py-1.5" to={playLink(item, plan)}>
                          {t('common.start')}
                        </ButtonLink>
                      )}
                    </li>
                  )
                })}
              </ol>
            </Card>
          )
        })}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Card title={t('nav.review')}>
          <p className="text-sm text-ink-2">{mistakes.length ? t('home.bank', { n: mistakes.length, due }) : t('home.bankEmpty')}</p>
          <p className="mt-1 text-sm text-ink-2">{t('home.words', { n: vocab.length, known: vocab.filter((v) => v.status === 'known').length })}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {mistakes.length > 0 && (
              <ButtonLink variant={due ? 'primary' : 'secondary'} to="/review/quick">
                {t('mistakes.quickReview')} →
              </ButtonLink>
            )}
            <ButtonLink to="/mistakes?tab=words">{t('review.tab.words')}</ButtonLink>
          </div>
        </Card>
        <Card title={t('home.speedTitle')}>
          <p className="mb-2 text-sm text-ink-3">
            {t('speed.current')}: <span className="font-medium text-ink">{speedLabel(settings.speed)}</span>
          </p>
          {advice.kind === 'not-enough-data' && (
            <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-accent" style={{ width: `${(advice.have / advice.need) * 100}%` }} />
            </div>
          )}
          <CoachLine tone={speedLine.tone}>{coach(speedLine.key, speedLine.params)}</CoachLine>
        </Card>
      </div>

      <Card title={t('home.testTitle')}>
        <p className="mb-3 text-sm text-ink-2">{t('home.testDesc')}</p>
        <Button variant={focus.some((f) => f.type === 'overclicking') ? 'primary' : 'secondary'} onClick={() => void startTest()}>
          {t('home.testStart')} →
        </Button>
        {testError && <p className="mt-2 text-sm text-bad">{t('home.testNotEnough')}</p>}
      </Card>

      <Card title={t('home.strategyTitle')}>
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-ink-2">
          <li>{t('home.strategy1')}</li>
          <li>{t('home.strategy2')}</li>
          <li>{t('home.strategy3')}</li>
          <li>{t('home.strategy4')}</li>
          <li>{t('home.strategy5')}</li>
        </ol>
      </Card>

      <div className="text-center">
        <Button variant="ghost" className="text-xs" onClick={() => setRegen((n) => n + 1)}>
          ↻ {t('home.regenerate')}
        </Button>
      </div>
    </div>
  )
}

export function playLink(item: PlanItem, plan: DailyPlan): string {
  return `/play/${item.exerciseId}?mode=${item.mode}&speed=${item.speed}&plan=${plan.id}`
}

export function reasonText(reason: string, tk: (k: string, p?: Record<string, string | number>) => string): string {
  const [head, arg] = reason.split(':')
  if (head === 'trap') return tk('reason.trap', { cat: tk(`trap.${arg}`) })
  if (head === 'review') return arg === 'false-positive' ? tk('reason.reviewFp') : tk('reason.review', { cat: tk(`trap.${arg}`) })
  return tk(`reason.${head}`)
}
