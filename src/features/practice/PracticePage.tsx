import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAppState } from '../../app/state'
import { recentAttempts } from '../../data/repo'
import { trapStats } from '../../domain/adaptive'
import { hasTrap, isHuman } from '../../domain/plan'
import { TRAP_CATEGORIES, type Attempt, type Exercise, type Mode, type TrapCategory } from '../../domain/types'
import { useI18n } from '../../i18n'
import { pct, secs, speedLabel } from '../../ui/format'
import { Badge, ButtonLink, Card, PageHeader, Segmented } from '../../ui/kit'
import { effectiveSpeed, MODE_RULES, STRESS_SPEEDS } from '../modes'

const PICKABLE: Mode[] = ['guided', 'fading', 'practice', 'drill', 'recovery', 'overclick', 'exam', 'stress']

export function PracticePage() {
  const { exercises, settings, ready } = useAppState()
  const { t, tk } = useI18n()
  const [params, setParams] = useSearchParams()
  const mode = (PICKABLE.includes(params.get('mode') as Mode) ? params.get('mode') : 'practice') as Mode
  const cat = params.get('cat') as TrapCategory | null
  const [stressSpeed, setStressSpeed] = useState<number>(1.1)
  const attempts = useLiveQuery(() => recentAttempts(), [], [])

  const last = useMemo(() => {
    const m = new Map<string, Attempt>()
    for (const a of attempts) if (!m.has(a.exerciseId)) m.set(a.exerciseId, a)
    return m
  }, [attempts])

  const traps = useMemo(() => new Map(trapStats(attempts).map((s) => [s.category, s])), [attempts])
  const availableCats = TRAP_CATEGORIES.filter((c) => exercises.some((e) => hasTrap(e, c)))

  const rules = MODE_RULES[mode]
  const list = useMemo(() => {
    let l = exercises.filter((e) => rules.kinds.includes(e.kind) || (e.custom && mode !== 'overclick'))
    if (mode === 'drill') {
      l = exercises.filter((e) => e.tokens.some((tk) => tk.isIncorrect))
      if (cat) l = l.filter((e) => hasTrap(e, cat))
    }
    const rank = (e: Exercise) => {
      const k = rules.kinds.indexOf(e.kind)
      return (k < 0 ? 99 : k) * 2 + (isHuman(e) ? 0 : 1)
    }
    return [...l].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
  }, [exercises, rules, mode, cat])

  const speed = effectiveSpeed(mode, mode === 'stress' ? stressSpeed : settings.speed)
  // Suggested: never-done first, then least recently done.
  const suggested = [...list].sort((a, b) => (last.get(a.id)?.completedAt ?? 0) - (last.get(b.id)?.completedAt ?? 0))[0]
  const link = (e: Exercise) => `/play/${e.id}?mode=${mode}&speed=${speed}`

  const setMode = (m: Mode) => setParams(m === 'drill' && cat ? { mode: m, cat } : { mode: m }, { replace: true })

  if (!ready) return <p className="p-6 text-ink-2">{t('common.loading')}</p>

  return (
    <div className="space-y-4">
      <PageHeader title={t('practice.title')} action={<ButtonLink to="/create">＋ {t('nav.create')}</ButtonLink>} />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {PICKABLE.map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            aria-pressed={m === mode}
            className={`rounded-xl border p-3 text-left transition-colors ${
              m === mode ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-surface-2'
            }`}
          >
            <div className={`text-sm font-semibold ${m === mode ? 'text-accent' : 'text-ink'}`}>{tk(`mode.${m}`)}</div>
          </button>
        ))}
      </div>

      <Card>
        <p className="text-sm text-ink-2">{tk(`modeDesc.${mode}`)}</p>
        {mode === 'stress' && (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <span className="text-sm text-ink-2">{t('practice.stressSpeed')}</span>
            <Segmented value={stressSpeed} onChange={setStressSpeed} options={STRESS_SPEEDS.map((s) => ({ value: s, label: speedLabel(s) }))} />
          </div>
        )}
        {mode === 'drill' && (
          <div className="mt-3">
            <div className="mb-2 text-xs font-medium text-ink-3">{t('practice.categories')}</div>
            <div className="flex flex-wrap gap-1.5">
              <CatChip active={!cat} onClick={() => setParams({ mode })}>
                {t('practice.allCategories')}
              </CatChip>
              {availableCats.map((c) => {
                const s = traps.get(c)
                return (
                  <CatChip key={c} active={cat === c} onClick={() => setParams({ mode, cat: c })}>
                    {tk(`trap.${c}`)}
                    {s && s.total > 0 && <span className={`ml-1 ${s.missRate >= 0.34 ? 'text-bad' : 'text-ink-3'}`}>{pct(s.missRate)}</span>}
                  </CatChip>
                )
              })}
            </div>
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {suggested && (
            <ButtonLink variant="primary" to={link(suggested)}>
              {t('practice.startNext')} →
            </ButtonLink>
          )}
          <span className="text-xs text-ink-3">
            {speedLabel(speed)} · {t('practice.speedNote')}
          </span>
        </div>
      </Card>

      <Card title={`${t('practice.exercises')} (${list.length})`}>
        <ul className="divide-y divide-line">
          {list.map((e) => {
            const a = last.get(e.id)
            const mm = e.tokens.filter((x) => x.isIncorrect).length
            return (
              <li key={e.id}>
                <Link to={link(e)} className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-surface-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-ink">{e.title}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
                      <Badge>{tk(`kind.${e.kind}`)}</Badge>
                      <span>{e.topic}</span>
                      <span>· {e.accent}</span>
                      <span>· {secs(e.durationMs, 0)}</span>
                      {isHuman(e) && <Badge tone="good">{t('practice.humanVoice')}</Badge>}
                      {e.custom && <Badge tone="accent">{t('nav.create')}</Badge>}
                      {e.timing !== 'exact' && <Badge tone="warn">{t('common.approx')}</Badge>}
                    </div>
                  </div>
                  <span className="shrink-0 text-xs text-ink-3 tabular-nums">
                    {a ? t('practice.lastScore', { net: a.summary.score.net, max: e.kind === 'overclick' ? '?' : mm }) : t('practice.never')}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      </Card>
    </div>
  )
}

function CatChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-3 py-1 text-xs ${active ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-2 hover:bg-surface-2'}`}
    >
      {children}
    </button>
  )
}
