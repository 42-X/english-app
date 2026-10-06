import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAppState } from '../../app/state'
import { newId } from '../../data/db'
import { saveAttempt } from '../../data/repo'
import { requestSync } from '../../data/sync'
import { summarize } from '../../domain/analysis'
import { lagOf, SYNC } from '../../domain/sync'
import { isAnchor } from '../../domain/text'
import { MODES, type Attempt, type Mode } from '../../domain/types'
import { useI18n } from '../../i18n'
import { clock, speedLabel } from '../../ui/format'
import { Badge, Button } from '../../ui/kit'
import { effectiveSpeed, fadingGuidance, MODE_RULES } from '../modes'
import { Transcript } from './Transcript'
import { usePlayerSession } from './usePlayerSession'

export function PlayerPage() {
  const { id = '' } = useParams()
  const [params] = useSearchParams()
  const { exerciseById, settings, ready } = useAppState()
  const { t } = useI18n()
  const ex = exerciseById.get(id)
  const modeParam = params.get('mode') as Mode | null
  const mode: Mode = modeParam && (MODES as readonly string[]).includes(modeParam) ? modeParam : 'practice'

  if (!ready) return <p className="p-6 text-ink-2">{t('common.loading')}</p>
  if (!ex) return <p className="p-6 text-ink-2">{t('player.notFound')}</p>
  const speed = effectiveSpeed(mode, Number(params.get('speed')) || settings.speed)
  return <Player key={`${ex.id}-${mode}-${speed}`} exerciseId={ex.id} mode={mode} speed={speed} planId={params.get('plan') ?? undefined} />
}

function Player({ exerciseId, mode, speed, planId }: { exerciseId: string; mode: Mode; speed: number; planId?: string }) {
  const { exerciseById, settings } = useAppState()
  const ex = exerciseById.get(exerciseId)!
  const { t, tk } = useI18n()
  const navigate = useNavigate()
  const rules = MODE_RULES[mode]
  const s = usePlayerSession(ex, mode, speed, rules.countdown ? settings.examCountdownSec : 0)
  const [lastPointerKind, setLastPointerKind] = useState<'mouse' | 'touch' | null>(null)
  const [saving, setSaving] = useState(false)
  const coarse = useMemo(() => window.matchMedia('(pointer: coarse)').matches, [])

  const anchors = useMemo(() => (rules.anchors ? new Set(ex.tokens.filter((_, i) => isAnchor(ex.tokens, i)).map((x) => x.index)) : null), [ex, rules.anchors])

  const active = s.phase === 'playing' || s.phase === 'paused'
  const progress = ex.tokens.length ? Math.max(0, s.spoken) / ex.tokens.length : 0
  let highlight: number | null = null
  let lineCue: number | null = null
  if (active && s.spoken >= 0) {
    if (rules.guidance === 'full') highlight = s.spoken
    else if (rules.guidance === 'fading') {
      const g = fadingGuidance(progress, settings.fading.full, settings.fading.line)
      if (g === 'word') highlight = s.spoken
      else if (g === 'line') lineCue = s.spoken
    }
  }

  const submit = async () => {
    if (saving) return
    setSaving(true)
    const c = s.collect()
    const now = Date.now()
    const base = { selected: rules.selectable ? c.selected : [], interactions: c.interactions, samples: c.samples, speed }
    const attempt: Attempt = {
      id: newId(),
      exerciseId: ex.id,
      mode,
      timing: s.exactTiming ? 'exact' : 'approximate',
      startedAt: c.startedAt || now,
      completedAt: now,
      ...base,
      blackouts: c.blackouts,
      confidence: {},
      planId,
      summary: summarize(ex, base),
      updatedAt: now,
    }
    await saveAttempt(attempt, ex)
    requestSync()
    navigate(`/results/${attempt.id}`, { replace: true })
  }

  // Guided tracking has nothing to submit, so finish automatically.
  useEffect(() => {
    if (s.phase === 'ended' && mode === 'guided') void submit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.phase, mode])

  // Keyboard: Space starts, and pauses only in modes that allow it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || (e.target as HTMLElement).closest('input,textarea,select,button')) return
      e.preventDefault()
      if (s.phase === 'ready') s.start()
      else if (rules.canPause && (s.phase === 'playing' || s.phase === 'paused')) s.togglePause()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [s, rules.canPause])

  const exit = () => {
    if (s.phase === 'ready' || s.phase === 'loading' || s.phase === 'error' || window.confirm(t('player.exitConfirm'))) navigate(-1)
  }

  const live = liveStatus(s.spoken, s.pointer)
  const showLive = rules.liveCoaching && settings.liveCoaching && active
  const exam = rules.layout === 'exam'

  return (
    <div className={`mx-auto flex min-h-dvh w-full flex-col ${exam ? 'max-w-4xl' : 'max-w-3xl'} px-4 pt-3 pb-6`}>
      <header className="flex items-center gap-2 pb-3">
        <Button variant="ghost" className="-ml-2 px-2" onClick={exit} aria-label={t('player.exit')}>
          ←
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-ink">{exam ? tk(`mode.${mode}`) : ex.title}</div>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
            {!exam && <span>{tk(`mode.${mode}`)}</span>}
            <span>· {speedLabel(speed)}</span>
            {!s.exactTiming && <Badge tone="warn">{t('common.approx')}</Badge>}
          </div>
        </div>
        {rules.selectable && <span className="text-sm text-ink-2 tabular-nums">{t('player.selected', { n: s.selected.size })}</span>}
      </header>

      <AudioStatus phase={s.phase} mediaMs={s.mediaMs} durationMs={ex.durationMs} countdown={s.countdown} exam={exam} />

      {mode === 'guided' && s.phase === 'ready' && <p className="mt-3 text-sm text-ink-2">{t('player.guidedNote')}</p>}

      <div
        className={`relative mt-3 rounded-xl border bg-surface ${exam ? 'border-line-strong p-4 sm:p-6' : 'border-line p-4 sm:p-7'} ${
          s.phase === 'ready' || s.phase === 'loading' ? 'opacity-90' : ''
        }`}
      >
        <Transcript
          tokens={ex.tokens}
          layout={rules.layout}
          showSpoken={mode === 'guided'}
          selected={s.selected}
          highlight={highlight}
          lineCue={lineCue}
          anchors={active ? anchors : null}
          pointerMarker={lastPointerKind === 'touch' && active ? s.pointer : null}
          interactive={rules.selectable && (active || s.phase === 'ended')}
          tracking={active}
          hidden={s.blackout}
          onPointerToken={(i, kind) => {
            s.setPointer(i)
            if (kind !== lastPointerKind) setLastPointerKind(kind)
          }}
          onToggle={s.toggle}
        />
        {s.blackout && (
          <div className="absolute inset-0 flex items-center justify-center rounded-xl">
            <span className="rounded-lg bg-surface px-3 py-1.5 text-sm font-medium text-ink-2 shadow">{t('player.blackout')}</span>
          </div>
        )}
      </div>

      <div className="mt-3 min-h-7 text-center">
        {showLive && (
          <span className={`inline-block rounded-full px-3 py-1 text-xs font-medium ${live.tone}`}>{live.key ? t(live.key, live.params) : ''}</span>
        )}
        {s.phase === 'ready' && <span className="text-xs text-ink-3">{coarse ? t('player.trackTouch') : t('player.trackMouse')}</span>}
      </div>

      <div className="sticky bottom-0 mt-auto flex items-center justify-center gap-3 bg-bg/90 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
        {s.phase === 'ready' && (
          <Button variant="primary" className="min-w-40 py-3 text-base" onClick={s.start}>
            {t('common.start')}
          </Button>
        )}
        {rules.canPause && (s.phase === 'playing' || s.phase === 'paused') && (
          <Button onClick={s.togglePause}>{s.phase === 'playing' ? t('player.pause') : t('player.resume')}</Button>
        )}
        {rules.selectable && (active || s.phase === 'ended') && (
          <Button variant={s.phase === 'ended' ? 'primary' : 'secondary'} className="min-w-32" onClick={submit} disabled={saving}>
            {t('player.submit')}
          </Button>
        )}
        {s.phase === 'error' && <p className="text-sm text-bad">{t('player.audioError')}</p>}
      </div>
    </div>
  )
}

function liveStatus(spoken: number, pointer: number | null): { key: Parameters<ReturnType<typeof useI18n>['t']>[0] | null; params?: Record<string, number>; tone: string } {
  if (spoken < 0) return { key: null, tone: '' }
  const lag = lagOf({ t: 0, spoken, pointer })
  if (lag === null) return { key: 'player.live.noPointer', tone: 'bg-surface-2 text-ink-2' }
  if (Math.abs(lag) <= SYNC.acceptable) return { key: 'player.live.synced', tone: 'bg-good-soft text-good' }
  if (Math.abs(lag) >= SYNC.loss && lag < 0) return { key: 'player.live.lost', tone: 'bg-bad-soft text-bad' }
  if (lag < 0) return { key: 'player.live.behind', params: { n: -lag }, tone: 'bg-warn-soft text-warn' }
  return { key: 'player.live.ahead', params: { n: lag }, tone: 'bg-warn-soft text-warn' }
}

function AudioStatus({ phase, mediaMs, durationMs, countdown, exam }: { phase: string; mediaMs: number; durationMs: number; countdown: number; exam: boolean }) {
  const { t } = useI18n()
  const label =
    phase === 'countdown'
      ? t('player.beginIn', { n: countdown })
      : phase === 'playing'
        ? t('player.playing')
        : phase === 'paused'
          ? t('player.paused')
          : phase === 'ended'
            ? t('player.ended')
            : phase === 'loading'
              ? t('common.loading')
              : t('player.startHint')
  const frac = phase === 'ended' ? 1 : Math.min(1, mediaMs / Math.max(1, durationMs))
  return (
    <div className={`rounded-lg border border-line ${exam ? 'bg-surface-2' : 'bg-surface'} px-3 py-2`}>
      <div className="flex items-center justify-between text-xs text-ink-2">
        <span>{label}</span>
        <span className="tabular-nums">
          {clock(phase === 'ended' ? durationMs : mediaMs)} / {clock(durationMs)}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3">
        <div className="h-full rounded-full bg-accent transition-[width] duration-100" style={{ width: `${frac * 100}%` }} />
      </div>
    </div>
  )
}
