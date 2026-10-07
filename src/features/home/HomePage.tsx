import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAppState } from '../../app/state'
import { markNoteRead, unreadNotes, type CoachNote } from '../../data/coach'
import { db } from '../../data/db'
import { addListeningToPlan, isOnboarded, trimPlan, liveMistakes, liveVocab, markOnboarded, recentAttempts, recentListening, startOverclickTest, todaysPlan } from '../../data/repo'
import { requestSync } from '../../data/sync'
import { speedAdvice, targetLevel, weaknesses } from '../../domain/adaptive'
import { speedCoaching } from '../../domain/coaching'
import { accuracyChange, activeDays, lastSevenDays, milestone, milestoneReachedToday, recommendations, sessions, wins, type Rec, type Wins } from '../../domain/momentum'
import { estimatedMinutes, localDate, QUEST_MAX } from '../../domain/plan'
import { compare } from '../../domain/report'
import { isDue, MASTERED, REVIEW_SESSION } from '../../domain/srs'
import type { Attempt, DailyPlan, ListeningAttempt, PlanItem } from '../../domain/types'
import { useCoachText, useI18n } from '../../i18n'
import { pct, speedLabel } from '../../ui/format'
import { Button, ButtonLink, Card, CoachLine, Disclosure } from '../../ui/kit'
import { useKeepGoing } from './keepGoing'

const DAY = 86_400_000

export function HomePage() {
  const { exercises, settings, ready } = useAppState()
  const { t, tk, lang } = useI18n()
  const coach = useCoachText()
  const navigate = useNavigate()
  const keepGoing = useKeepGoing()
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

  // Older plans: add FIB-L/WFD if missing, and trim a pre-quest 8–12 item plan to a finishable quest.
  useEffect(() => {
    if (ready && plan && plan.kind !== 'overclick-test' && !plan.items.some((i) => i.task === 'fibl' || i.task === 'wfd')) {
      void addListeningToPlan(plan.id, exercises).then(requestSync)
    } else if (ready && plan && plan.items.filter((i) => !i.bonus).length > QUEST_MAX) {
      void trimPlan(plan.id).then(requestSync)
    }
  }, [ready, plan, exercises])

  const attempts = useLiveQuery(() => recentAttempts(), [], [])
  const listening = useLiveQuery(() => recentListening(undefined, 2000), [], [])
  const mistakes = useLiveQuery(() => liveMistakes(), [], [])
  const vocab = useLiveQuery(() => liveVocab(), [], [])
  const onboarded = useLiveQuery(() => isOnboarded(), [], true)

  const startTest = async () => {
    const test = await startOverclickTest(exercises)
    if (!test) return setTestError(true)
    navigate(`${playLink(test.items[0], test)}&flow=test`)
  }

  if (!ready || !plan) return <p className="p-6 text-ink-2">{t('common.loading')}</p>

  const now = Date.now()
  const todayStart = new Date(`${date}T00:00:00`).getTime()
  const days = activeDays(sessions(attempts, listening))
  const lifetime = wins(attempts, listening)
  const today = wins(attempts, listening, todayStart)
  const due = mistakes.filter((m) => isDue(m, now)).length
  const mastered = mistakes.filter((m) => m.step >= MASTERED).length
  const recs = recommendations({ exercises, attempts, listening, mistakes, learningWords: vocab.filter((v) => v.status === 'learning').length, now })
  const advice = speedAdvice(attempts, settings.speed)
  const speedLine = speedCoaching(advice)
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'
  const dateLabel = new Date().toLocaleDateString(lang, { weekday: 'long', month: 'long', day: 'numeric' })

  return (
    <div className="space-y-4">
      <header className="mb-1">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{t(`home.greeting.${greeting}`)}</h1>
        <p className="mt-1 text-sm text-ink-2">{dateLabel}</p>
      </header>

      {!onboarded && (
        <Card title={t('home.howTitle')} action={<Button variant="ghost" onClick={() => void markOnboarded()}>{t('home.dismiss')}</Button>}>
          <HowTracking />
        </Card>
      )}

      <CoachNotes />

      <Momentum days={days} now={now} lifetime={lifetime.caught + lifetime.written} today={today} />

      <Quest plan={plan} todayMinutes={today.minutes} todayPoints={today.caught + today.written} onKeepGoing={() => void keepGoing()} />

      {recs.length > 0 && (
        <Card title={t('home.recTitle')}>
          <p className="-mt-2 mb-3 text-xs text-ink-3">{t('home.recSub')}</p>
          <ul className="grid gap-2 sm:grid-cols-3">
            {recs.map((r, i) => (
              <li key={i}>
                <RecCard rec={r} speed={settings.speed} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <ThisWeek now={now} attempts={attempts} listening={listening} />
        <Card title={t('nav.review')}>
          <p className="text-sm text-ink-2">
            {mistakes.length === 0 ? t('home.bankEmpty') : due ? t('home.bank', { session: Math.min(due, REVIEW_SESSION) }) : t('home.bankNone')}
            {mastered > 0 && ` ${t('home.mastered', { n: mastered })}`}
          </p>
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
      </div>

      <Disclosure title={t('home.toolsTitle')}>
        <p className="text-sm text-ink-2">{t('home.levelNote', { level: tk(`home.level.${targetLevel(attempts)}`) })}</p>
        <section>
          <h3 className="mb-1 text-sm font-semibold text-ink">{t('home.speedTitle')}</h3>
          <p className="mb-2 text-sm text-ink-3">
            {t('speed.current')}: <span className="font-medium text-ink">{speedLabel(settings.speed)}</span>
          </p>
          <CoachLine tone={speedLine.tone}>{coach(speedLine.key, speedLine.params)}</CoachLine>
        </section>
        <section>
          <h3 className="mb-1 text-sm font-semibold text-ink">{t('home.testTitle')}</h3>
          <p className="mb-2 text-sm text-ink-2">{t('home.testDesc')}</p>
          <Button variant={weaknesses(attempts).some((f) => f.type === 'overclicking') ? 'primary' : 'secondary'} onClick={() => void startTest()}>
            {t('home.testStart')} →
          </Button>
          {testError && <p className="mt-2 text-sm text-bad">{t('home.testNotEnough')}</p>}
        </section>
        <section>
          <h3 className="mb-1 text-sm font-semibold text-ink">{t('home.strategyTitle')}</h3>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-ink-2">
            <li>{t('home.strategy1')}</li>
            <li>{t('home.strategy2')}</li>
            <li>{t('home.strategy3')}</li>
            <li>{t('home.strategy4')}</li>
            <li>{t('home.strategy5')}</li>
          </ol>
        </section>
        {onboarded && (
          <section>
            <h3 className="mb-1 text-sm font-semibold text-ink">{t('home.howTitle')}</h3>
            <HowTracking />
          </section>
        )}
        <Button variant="ghost" className="-ml-2 text-xs" onClick={() => setRegen((n) => n + 1)}>
          ↻ {t('home.regenerate')}
        </Button>
      </Disclosure>
    </div>
  )
}

/** Unread notes from her coach, newest first, until she taps "Thanks". Online only; silent otherwise. */
function CoachNotes() {
  const { t } = useI18n()
  const [notes, setNotes] = useState<CoachNote[]>([])
  useEffect(() => {
    let live = true
    unreadNotes().then(
      (n) => live && setNotes(n),
      () => {},
    )
    return () => {
      live = false
    }
  }, [])
  if (!notes.length) return null
  return (
    <div className="space-y-2">
      {notes.map((n) => (
        <section key={n.id} className="rounded-xl border border-accent bg-accent-soft p-4">
          <div className="text-xs font-semibold text-accent">💬 {t('coachNote.title')}</div>
          <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-ink">{n.body}</p>
          <Button
            variant="primary"
            className="mt-3 px-3 py-1.5"
            onClick={() => {
              setNotes((xs) => xs.filter((x) => x.id !== n.id))
              void markNoteRead(n.id).catch(() => {})
            }}
          >
            {t('coachNote.thanks')}
          </Button>
        </section>
      ))}
    </div>
  )
}

function HowTracking() {
  const { t } = useI18n()
  return (
    <ul className="space-y-1.5 text-sm text-ink-2">
      <li>🖱️ {t('home.howDesktop')}</li>
      <li>👆 {t('home.howMobile')}</li>
    </ul>
  )
}

/** Effort that only ever grows: time today, days practised, points earned. No streak to lose. */
function Momentum({ days, now, lifetime, today }: { days: ReadonlySet<string>; now: number; lifetime: number; today: Wins }) {
  const { t, lang } = useI18n()
  const week = lastSevenDays(days, now)
  const m = milestone(lifetime)
  const passed = milestoneReachedToday(lifetime - today.caught - today.written, lifetime)
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      <div className="rounded-xl border border-line bg-surface px-4 py-3">
        <div className="text-xs text-ink-3">{t('home.todayLabel')}</div>
        <div className="mt-0.5 text-2xl font-semibold text-ink tabular-nums">{t('home.minutes', { n: today.minutes })}</div>
        <div className="mt-0.5 text-xs text-ink-3">{today.done ? t('home.todayDone', { n: today.done }) : t('home.todayNone')}</div>
      </div>
      <div className="rounded-xl border border-line bg-surface px-4 py-3">
        <div className="text-xs text-ink-3">{t('home.daysLabel', { n: week.filter((d) => d.active).length })}</div>
        <div className="mt-2 flex justify-between gap-1">
          {week.map((d) => (
            <div key={d.date} className="flex flex-col items-center gap-1">
              <span
                className={`h-5 w-5 rounded-full ${d.active ? 'bg-good' : 'bg-surface-2'} ${d.today ? 'ring-2 ring-accent ring-offset-1 ring-offset-surface' : ''}`}
                aria-label={d.active ? `${d.date} ✓` : d.date}
              />
              <span className="text-[10px] text-ink-3">{new Date(`${d.date}T00:00:00`).toLocaleDateString(lang, { weekday: 'narrow' })}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="col-span-2 rounded-xl border border-line bg-surface px-4 py-3 sm:col-span-1" title={t('home.earnedSub')}>
        <div className="text-xs text-ink-3">{t('home.earned')}</div>
        <div className="mt-0.5 text-2xl font-semibold text-ink tabular-nums">⭐ {lifetime.toLocaleString(lang)}</div>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
          <div className="h-full rounded-full bg-accent" style={{ width: `${((lifetime - m.prev) / (m.next - m.prev)) * 100}%` }} />
        </div>
        <div className={`mt-1 text-xs ${passed ? 'font-medium text-good' : 'text-ink-3'}`}>
          {passed ? t('home.milestoneToday', { m: passed.toLocaleString(lang) }) : t('home.toMilestone', { left: m.next - lifetime, next: m.next.toLocaleString(lang) })}
        </div>
      </div>
    </div>
  )
}

function Quest({ plan, todayMinutes, todayPoints, onKeepGoing }: { plan: DailyPlan; todayMinutes: number; todayPoints: number; onKeepGoing: () => void }) {
  const { t } = useI18n()
  const { exerciseById } = useAppState()
  const quest = plan.items.filter((i) => !i.bonus)
  const bonus = plan.items.filter((i) => i.bonus)
  const done = quest.filter((i) => i.attemptId).length
  const complete = done === quest.length
  const next = plan.items.find((i) => !i.attemptId)
  const minutes = estimatedMinutes({ ...plan, items: quest }, exerciseById)

  return (
    <section className={`rounded-xl border p-4 sm:p-5 ${complete ? 'border-good bg-good-soft' : 'border-line bg-surface'}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-ink">🎯 {t('home.quest')}</h2>
        <span className="text-xs text-ink-3">{t('home.questSub', { min: minutes, done, total: quest.length })}</span>
      </div>
      <div className="mt-3 flex gap-1" aria-hidden>
        {quest.map((i, k) => (
          <span key={k} className={`h-2.5 flex-1 rounded-full ${i.attemptId ? 'bg-good' : i === next ? 'bg-accent/50' : 'bg-surface-2'}`} />
        ))}
      </div>

      {complete ? (
        <div className="mt-4 space-y-3">
          <div>
            <div className="text-lg font-semibold text-ink">{t('home.allDone')}</div>
            <p className="mt-1 text-sm text-ink-2">{t('home.questDoneSub', { min: todayMinutes, pts: todayPoints })}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {next ? (
              <ButtonLink variant="primary" className="py-2.5" to={playLink(next, plan)}>
                {t('home.keepGoing')} →
              </ButtonLink>
            ) : (
              <Button variant="primary" className="py-2.5" onClick={onKeepGoing}>
                {t('home.keepGoing')} →
              </Button>
            )}
            <ButtonLink to={`/report/${plan.id}`}>{t('report.day.open')}</ButtonLink>
          </div>
          <p className="text-xs text-ink-3">
            {t('home.keepGoingSub')}
            {bonus.some((i) => i.attemptId) && ` · ${t('home.bonusDone', { n: bonus.filter((i) => i.attemptId).length })}`}
          </p>
        </div>
      ) : (
        next && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs text-ink-3">{t('home.upNext', { n: plan.items.indexOf(next) + 1 })}</div>
              <ItemTitle item={next} />
            </div>
            <ButtonLink variant="primary" className="py-2.5" to={playLink(next, plan)}>
              {done ? t('common.continue') : t('home.startNext')} →
            </ButtonLink>
          </div>
        )
      )}

      <details className="group mt-4">
        <summary className="cursor-pointer list-none text-xs font-medium text-accent [&::-webkit-details-marker]:hidden">
          <span className="inline-block transition-transform group-open:rotate-90">›</span> {t('home.questSteps')}
        </summary>
        <ItemList plan={plan} items={quest} next={next} />
        {bonus.length > 0 && (
          <>
            <div className="mt-3 text-xs font-semibold text-ink-2">{t('home.bonusTitle')}</div>
            <ItemList plan={plan} items={bonus} next={next} />
          </>
        )}
      </details>
    </section>
  )
}

function ItemTitle({ item }: { item: PlanItem }) {
  const { t, tk } = useI18n()
  const { exerciseById } = useAppState()
  return (
    <div className="truncate font-medium text-ink">
      {item.task === 'wfd' ? t('wfd.setTitle', { n: item.sentences?.length ?? 0 }) : exerciseById.get(item.exerciseId)?.title} ·{' '}
      <span className="text-ink-2">{taskLabel(item, tk)}</span>
    </div>
  )
}

function ItemList({ plan, items, next }: { plan: DailyPlan; items: PlanItem[]; next: PlanItem | undefined }) {
  const { t, tk } = useI18n()
  const { exerciseById } = useAppState()
  return (
    <ol className="mt-2 divide-y divide-line">
      {items.map((item) => {
        const isNext = item === next
        return (
          <li key={plan.items.indexOf(item)} className="flex items-center gap-3 py-2.5">
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${
                item.attemptId ? 'bg-good text-on-accent' : isNext ? 'bg-accent text-on-accent' : 'bg-surface-2 text-ink-3'
              }`}
              aria-label={item.attemptId ? t('home.done') : undefined}
            >
              {item.attemptId ? '✓' : plan.items.indexOf(item) + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-ink">
                {item.task === 'wfd' ? t('wfd.setTitle', { n: item.sentences?.length ?? 0 }) : (exerciseById.get(item.exerciseId)?.title ?? item.exerciseId)}
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
                <span>{taskLabel(item, tk)}</span>
                {!item.task && <span>· {speedLabel(item.speed)}</span>}
                <span>· {reasonText(item.reason, tk)}</span>
              </div>
            </div>
            {item.attemptId ? (
              <Link className="text-xs text-accent hover:underline" to={resultLink(item)}>
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
  )
}

const REC_ICON: Record<Rec['kind'], string> = {
  review: '✎',
  trap: '🎯',
  overclicking: '✋',
  tracking: '👆',
  latency: '⚡',
  discrimination: '👂',
  fibl: '✍️',
  wfd: '🎧',
  words: '📖',
  exam: '⏱',
  practice: '▶',
}

function recLink(r: Rec, speed: number): string {
  switch (r.kind) {
    case 'review':
      return '/review/quick'
    case 'words':
      return '/mistakes?tab=words'
    case 'wfd':
      return '/wfd?mode=practice'
    case 'fibl':
      return `/fibl/${r.exerciseId}?mode=practice`
    case 'trap':
    case 'discrimination':
      return `/play/${r.exerciseId}?mode=drill&speed=${speed}`
    case 'overclicking':
      return `/play/${r.exerciseId}?mode=overclick&speed=${speed}`
    case 'tracking':
      return `/play/${r.exerciseId}?mode=fading&speed=1`
    case 'exam':
      return `/play/${r.exerciseId}?mode=exam&speed=1`
    default:
      return `/play/${r.exerciseId}?mode=practice&speed=${speed}`
  }
}

function RecCard({ rec, speed }: { rec: Rec; speed: number }) {
  const { tk } = useI18n()
  const params: Record<string, string | number> | undefined =
    rec.kind === 'review' ? { n: rec.due } : rec.kind === 'words' ? { n: rec.learning } : rec.kind === 'trap' ? { cat: tk(`trap.${rec.category}`) } : undefined
  return (
    <Link to={recLink(rec, speed)} className="flex h-full items-start gap-3 rounded-lg border border-line p-3 transition-colors hover:border-accent hover:bg-accent-soft">
      <span aria-hidden className="text-xl leading-none">
        {REC_ICON[rec.kind]}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ink">{tk(`rec.${rec.kind}.title`, params)}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-ink-2">{tk(`rec.${rec.kind}.why`)}</span>
      </span>
      <span aria-hidden className="text-accent">
        →
      </span>
    </Link>
  )
}

/** Week-over-week: effort always, and only the measures that went up. */
function ThisWeek({ now, attempts, listening }: { now: number; attempts: readonly Attempt[]; listening: readonly ListeningAttempt[] }) {
  const { t, tk } = useI18n()
  const weekStart = now - 7 * DAY
  const w = wins(attempts, listening, weekStart)
  const lastWeek = attempts.filter((a) => a.completedAt < weekStart && a.completedAt >= weekStart - 7 * DAY)
  const hadLastWeek = lastWeek.length > 0 || listening.some((a) => a.completedAt < weekStart && a.completedAt >= weekStart - 7 * DAY)
  const ups: { label: string; text: string }[] = compare(
    attempts.filter((a) => a.completedAt >= weekStart),
    lastWeek,
  )
    .filter((d) => d.change >= 3)
    .map((d) => ({
      label: tk(`report.metric.${d.metric}`),
      text: d.metric === 'fpPerPassage' ? `${d.before.toFixed(1)} → ${d.now.toFixed(1)}` : `${pct(d.before)} → ${pct(d.now)}`,
    }))
  for (const task of ['fibl', 'wfd'] as const) {
    const c = accuracyChange(listening, task, weekStart)
    if (c !== null && c >= 3) ups.push({ label: task === 'fibl' ? 'Fill in the Blanks' : 'Write From Dictation', text: `+${c}` })
  }
  return (
    <Card title={t('home.weekTitle')}>
      <p className="text-sm text-ink">{t('home.weekStats', { done: w.done, min: w.minutes, pts: w.caught + w.written })}</p>
      <div className="mt-2">
        {ups.length > 0 ? (
          <ul className="space-y-1 text-sm">
            {ups.map((u) => (
              <li key={u.label} className="flex items-center gap-2">
                <span className="text-good">▲</span>
                <span className="text-ink">{u.label}</span>
                <span className="text-ink-2 tabular-nums">{u.text}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-2">{hadLastWeek ? t('home.growthSteady') : t('home.growthNone')}</p>
        )}
      </div>
      <Link to="/progress" className="mt-3 inline-block text-xs text-accent hover:underline">
        {t('home.seeProgress')} →
      </Link>
    </Card>
  )
}

function taskLabel(item: PlanItem, tk: (k: string) => string): string {
  return item.task === 'fibl' ? 'Fill in the Blanks' : item.task === 'wfd' ? 'Write From Dictation' : tk(`mode.${item.mode}`)
}

export function playLink(item: PlanItem, plan: DailyPlan): string {
  if (item.task === 'fibl') return `/fibl/${item.exerciseId}?mode=${item.mode === 'exam' ? 'exam' : 'practice'}&plan=${plan.id}`
  if (item.task === 'wfd') return `/wfd?mode=${item.mode === 'exam' ? 'exam' : 'practice'}&plan=${plan.id}`
  return `/play/${item.exerciseId}?mode=${item.mode}&speed=${item.speed}&plan=${plan.id}`
}

/** Where a finished plan item's results live. */
export function resultLink(item: PlanItem): string {
  return item.task === 'fibl' || item.task === 'wfd' ? `/listening/${item.attemptId}` : `/results/${item.attemptId}`
}

export function reasonText(reason: string, tk: (k: string, p?: Record<string, string | number>) => string): string {
  const [head, arg] = reason.split(':')
  if (head === 'trap') return tk('reason.trap', { cat: tk(`trap.${arg}`) })
  if (head === 'review') return arg === 'false-positive' ? tk('reason.reviewFp') : tk('reason.review', { cat: tk(`trap.${arg}`) })
  return tk(`reason.${head}`)
}
