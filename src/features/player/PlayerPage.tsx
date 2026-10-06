import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAppState } from '../../app/state'
import { db, newId } from '../../data/db'
import { saveAttempt } from '../../data/repo'
import { requestSync } from '../../data/sync'
import { summarize } from '../../domain/analysis'
import { lagOf, SYNC } from '../../domain/sync'
import { isAnchor } from '../../domain/text'
import { MODES, type Attempt, type Mode } from '../../domain/types'
import { useI18n, type StringKey } from '../../i18n'
import { clock, speedLabel } from '../../ui/format'
import { Badge, Button } from '../../ui/kit'
import { playLink } from '../home/HomePage'
import { effectiveSpeed, fadingGuidance, MODE_RULES } from '../modes'
import { Transcript } from './Transcript'
import { usePlayerSession, type Phase } from './usePlayerSession'

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
  return (
    <Player
      key={`${ex.id}-${mode}-${speed}`}
      exerciseId={ex.id}
      mode={mode}
      speed={speed}
      planId={params.get('plan') ?? undefined}
      flow={params.get('flow') === 'test' ? 'test' : 'review'}
    />
  )
}

function readVolume(): number {
  try {
    const v = Number(localStorage.getItem('hiw-volume'))
    return v > 0 && v <= 1 ? v : 1
  } catch {
    return 1
  }
}

function Player({ exerciseId, mode, speed, planId, flow }: { exerciseId: string; mode: Mode; speed: number; planId?: string; flow: 'test' | 'review' }) {
  const { exerciseById, settings } = useAppState()
  const ex = exerciseById.get(exerciseId)!
  const { t, tk } = useI18n()
  const navigate = useNavigate()
  const rules = MODE_RULES[mode]
  const s = usePlayerSession(ex, mode, speed, settings.countdownSec, rules.selectable)
  const [lastPointerKind, setLastPointerKind] = useState<'mouse' | 'touch' | null>(null)
  const [saving, setSaving] = useState(false)
  const [volume, setVolume] = useState(readVolume)

  useEffect(() => s.setVolume(volume), [s, volume])

  const anchors = useMemo(() => (rules.anchors ? new Set(ex.tokens.filter((_, i) => isAnchor(ex.tokens, i)).map((x) => x.index)) : null), [ex, rules.anchors])

  const active = s.phase === 'playing' || s.phase === 'paused'
  const progress = ex.tokens.length ? Math.max(0, s.spoken) / ex.tokens.length : 0
  let highlight: number | null = null
  let lineCue: number | null = null
  // Guidance is withheld while a tracking check is waiting — the point is to see if she knows where she is.
  if (active && s.spoken >= 0 && !s.checking) {
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
      checks: c.checks,
      confidence: {},
      planId,
      summary: summarize(ex, base),
      updatedAt: now,
    }
    await saveAttempt(attempt, ex)
    requestSync()
    if (flow === 'test' && planId) {
      // Diagnostic tests run back-to-back like the exam; results come at the end.
      const plan = await db.plans.get(planId)
      const next = plan?.items.find((i) => !i.attemptId)
      navigate(next && plan ? `${playLink(next, plan)}&flow=test` : `/report/${planId}`, { replace: true })
      return
    }
    navigate(`/results/${attempt.id}`, { replace: true })
  }

  // Guided tracking has nothing to select, so it finishes when the recording ends.
  useEffect(() => {
    if (s.phase === 'ended' && mode === 'guided') void submit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.phase, mode])

  // Space pauses/resumes only in learning modes that allow it (the exam has no pause).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || (e.target as HTMLElement).closest('input,textarea,select,button')) return
      e.preventDefault()
      if (s.phase === 'needs-tap') s.begin()
      else if (rules.canPause && (s.phase === 'playing' || s.phase === 'paused')) s.togglePause()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [s, rules.canPause])

  const exit = () => {
    if (s.phase === 'needs-tap' || s.phase === 'loading' || s.phase === 'error' || window.confirm(t('player.exitConfirm'))) navigate(-1)
  }

  const live = liveStatus(s.spoken, s.pointer)
  const showLive = rules.liveCoaching && settings.liveCoaching && active && !s.checking
  const learning = rules.liveCoaching

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-4xl flex-col px-4 pt-3 pb-6">
      <header className="flex items-center gap-2 pb-2">
        <Button variant="ghost" className="-ml-2 px-2" onClick={exit} aria-label={t('player.exit')}>
          ←
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-ink">{learning ? ex.title : 'Highlight Incorrect Words'}</div>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
            <span>{tk(`mode.${mode}`)}</span>
            <span>· {speedLabel(speed)}</span>
            {!s.exactTiming && <Badge tone="warn">{t('common.approx')}</Badge>}
          </div>
        </div>
        {rules.selectable && <span className="text-sm text-ink-2 tabular-nums">{t('player.selected', { n: s.selected.size })}</span>}
      </header>

      <p className="pb-3 text-[13px] leading-snug text-ink-2">
        {mode === 'guided'
          ? 'You will hear a recording. Follow the transcript below word by word with your cursor or finger.'
          : 'You will hear a recording. Some words in the transcript below differ from what the speaker says. Click on the words that are different.'}
      </p>

      <StatusBox
        phase={s.phase}
        mediaMs={s.mediaMs}
        durationMs={ex.durationMs}
        countdown={s.countdown}
        volume={volume}
        onVolume={(v) => {
          setVolume(v)
          try {
            localStorage.setItem('hiw-volume', String(v))
          } catch {
            /* per-device convenience only */
          }
        }}
        onBegin={s.begin}
        onPause={rules.canPause ? s.togglePause : undefined}
      />

      <div className="relative mt-3 rounded-lg border border-line-strong bg-surface p-4 sm:p-6">
        <Transcript
          tokens={ex.tokens}
          layout="exam"
          showSpoken={mode === 'guided'}
          selected={s.selected}
          highlight={highlight}
          lineCue={lineCue}
          anchors={active ? anchors : null}
          pointerMarker={lastPointerKind === 'touch' && active ? s.pointer : null}
          interactive={s.checking || (rules.selectable && (active || s.phase === 'ended'))}
          tracking={active}
          hidden={s.blackout}
          follow={active ? s.spoken : null}
          onPointerToken={(i, kind) => {
            s.setPointer(i)
            if (kind !== lastPointerKind) setLastPointerKind(kind)
          }}
          onToggle={s.tap}
        />
        {s.blackout && (
          <div className="absolute inset-0 flex items-center justify-center rounded-lg">
            <span className="rounded-lg bg-surface px-3 py-1.5 text-sm font-medium text-ink-2 shadow">{t('player.blackout')}</span>
          </div>
        )}
      </div>

      <div className="mt-3 flex items-start justify-between gap-3">
        <div className="min-h-7">
          {s.checking && <span className="inline-block animate-pulse rounded-full bg-accent px-3 py-1 text-xs font-semibold text-on-accent">{t('player.check.prompt')}</span>}
          {s.checkFeedback && !s.checking && (
            <span
              className={`inline-block rounded-full px-3 py-1 text-xs font-medium ${
                s.checkFeedback.off === null ? 'bg-bad-soft text-bad' : Math.abs(s.checkFeedback.off) <= 1 ? 'bg-good-soft text-good' : 'bg-warn-soft text-warn'
              }`}
            >
              {s.checkFeedback.off === null
                ? t('player.check.missed')
                : Math.abs(s.checkFeedback.off) <= 1
                  ? t('player.check.ok')
                  : t('player.check.off', { n: Math.abs(s.checkFeedback.off) })}
            </span>
          )}
          {showLive && !s.checkFeedback && live.key && <span className={`inline-block rounded-full px-3 py-1 text-xs font-medium ${live.tone}`}>{t(live.key, live.params)}</span>}
          {s.phase === 'error' && <span className="text-sm text-bad">{t('player.audioError')}</span>}
        </div>
        {(rules.selectable || mode === 'guided') && s.phase !== 'loading' && s.phase !== 'error' && (
          <Button variant={s.phase === 'ended' ? 'primary' : 'secondary'} className="min-w-28 shrink-0" onClick={submit} disabled={saving || s.phase === 'needs-tap'}>
            {t('player.next')}
          </Button>
        )}
      </div>
    </div>
  )
}

function liveStatus(spoken: number, pointer: number | null): { key: StringKey | null; params?: Record<string, number>; tone: string } {
  if (spoken < 0) return { key: null, tone: '' }
  const lag = lagOf({ t: 0, spoken, pointer })
  if (lag === null) return { key: 'player.live.noPointer', tone: 'bg-surface-2 text-ink-2' }
  if (Math.abs(lag) <= SYNC.acceptable) return { key: 'player.live.synced', tone: 'bg-good-soft text-good' }
  if (Math.abs(lag) >= SYNC.loss && lag < 0) return { key: 'player.live.lost', tone: 'bg-bad-soft text-bad' }
  if (lag < 0) return { key: 'player.live.behind', params: { n: -lag }, tone: 'bg-warn-soft text-warn' }
  return { key: 'player.live.ahead', params: { n: lag }, tone: 'bg-warn-soft text-warn' }
}

/** Exam-style audio box: status line, progress bar and volume, directly above the passage. */
function StatusBox(p: {
  phase: Phase
  mediaMs: number
  durationMs: number
  countdown: number
  volume: number
  onVolume: (v: number) => void
  onBegin: () => void
  onPause?: () => void
}) {
  const { t } = useI18n()
  const status =
    p.phase === 'countdown'
      ? `Beginning in ${p.countdown} second${p.countdown === 1 ? '' : 's'}`
      : p.phase === 'playing'
        ? 'Playing'
        : p.phase === 'paused'
          ? 'Paused'
          : p.phase === 'ended'
            ? 'Completed'
            : p.phase === 'loading'
              ? 'Loading…'
              : p.phase === 'needs-tap'
                ? 'Ready'
                : ''
  const frac = p.phase === 'ended' ? 1 : Math.min(1, p.mediaMs / Math.max(1, p.durationMs))
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line-strong bg-surface-2 px-3 py-2.5 sm:max-w-md">
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-ink-2">
            Status: <span className="font-medium text-ink">{status}</span>
          </span>
          {p.phase !== 'needs-tap' && <span className="text-ink-3 tabular-nums">{clock(p.phase === 'ended' ? p.durationMs : p.mediaMs)}</span>}
        </div>
        <div className="mt-1.5 h-2 overflow-hidden rounded-sm bg-surface-3">
          <div className="h-full bg-accent transition-[width] duration-100" style={{ width: `${frac * 100}%` }} />
        </div>
      </div>
      {p.phase === 'needs-tap' ? (
        <Button variant="primary" className="shrink-0 px-3 py-1.5" onClick={p.onBegin}>
          {t('player.tapToStart')}
        </Button>
      ) : (
        <>
          {p.onPause && (p.phase === 'playing' || p.phase === 'paused') && (
            <button
              onClick={p.onPause}
              className="shrink-0 rounded-md border border-line px-2 py-1 text-xs text-ink-2 hover:bg-surface"
              aria-label={p.phase === 'playing' ? t('player.pause') : t('player.resume')}
            >
              {p.phase === 'playing' ? '❚❚' : '▶'}
            </button>
          )}
          <label className="flex shrink-0 items-center gap-1 text-ink-3" title="Volume">
            <span aria-hidden className="text-sm">
              🔊
            </span>
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              value={p.volume}
              onChange={(e) => p.onVolume(Number(e.target.value))}
              className="w-16 accent-[var(--accent)] sm:w-20"
              aria-label="Volume"
            />
          </label>
        </>
      )}
    </div>
  )
}
