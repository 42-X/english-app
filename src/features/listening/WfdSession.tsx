import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAppState } from '../../app/state'
import { isAudioUnlocked, playRange, stopSnippet, unlockAudio } from '../../audio/engine'
import { db, newId } from '../../data/db'
import { recentListening, saveListeningAttempt } from '../../data/repo'
import { requestSync } from '../../data/sync'
import { extractWfd, scoreWfd, type WfdSentence } from '../../domain/listening'
import { WFD_SET } from '../../domain/plan'
import type { ListeningAttempt, ListeningItemResult } from '../../domain/types'
import { useI18n } from '../../i18n'
import { Button } from '../../ui/kit'
import { readVolume, StatusBox } from '../player/PlayerPage'
import { RAW_INPUT } from './FiblPlayer'

type Phase = 'needs-tap' | 'countdown' | 'playing' | 'ended'

export function WfdPage() {
  const [params] = useSearchParams()
  const { exercises, ready } = useAppState()
  const { t } = useI18n()
  const planId = params.get('plan') ?? undefined
  const mode = params.get('mode') === 'exam' ? 'exam' : 'practice'
  const all = useMemo(() => extractWfd(exercises), [exercises])
  const history = useLiveQuery(() => recentListening('wfd', 100), [], undefined)
  const plan = useLiveQuery(async () => (planId ? await db.plans.get(planId) : undefined), [planId], null)

  const set = useMemo<WfdSentence[] | null>(() => {
    if (!ready || history === undefined || plan === null) return null
    const byId = new Map(all.map((s) => [s.id, s]))
    const planned = plan?.items.find((i) => i.task === 'wfd' && !i.attemptId)?.sentences
    if (planned) return planned.map((id) => byId.get(id)).filter((s): s is WfdSentence => !!s)
    // Free practice: least recently dictated first.
    const last = new Map<string, number>()
    for (const a of history) for (const it of a.items) if (!last.has(it.ref)) last.set(it.ref, a.completedAt)
    return [...all].sort((a, b) => (last.get(a.id) ?? 0) - (last.get(b.id) ?? 0) || a.id.localeCompare(b.id)).slice(0, WFD_SET)
  }, [ready, history, plan, all])

  if (!set) return <p className="p-6 text-ink-2">{t('common.loading')}</p>
  if (set.length === 0) return <p className="p-6 text-ink-2">{t('player.notFound')}</p>
  return <WfdRunner sentences={set} mode={mode} planId={planId} />
}

function WfdRunner({ sentences, mode, planId }: { sentences: WfdSentence[]; mode: 'practice' | 'exam'; planId?: string }) {
  const { exerciseById, settings } = useAppState()
  const { t } = useI18n()
  const navigate = useNavigate()
  const [i, setI] = useState(0)
  const [phase, setPhase] = useState<Phase>(isAudioUnlocked() ? 'countdown' : 'needs-tap')
  const [countdown, setCountdown] = useState(mode === 'exam' ? settings.countdownSec : 3)
  const [progress, setProgress] = useState(0)
  const [typed, setTyped] = useState('')
  const [replays, setReplays] = useState(0)
  const [volume, setVolume] = useState(readVolume)
  const results = useRef<ListeningItemResult[]>([])
  const startedAt = useRef(Date.now())
  const input = useRef<HTMLTextAreaElement>(null)
  const sentence = sentences[i]
  const ex = exerciseById.get(sentence.exerciseId)

  useEffect(() => stopSnippet, [])

  const play = () => {
    if (!ex) return
    setPhase('playing')
    setProgress(0)
    void playRange(ex, sentence.startMs, sentence.endMs, { volume, onProgress: setProgress, onEnd: () => setPhase('ended') })
    input.current?.focus()
  }

  // "Beginning in N seconds", then the sentence plays once by itself.
  useEffect(() => {
    if (phase !== 'countdown') return
    if (countdown <= 0) return play()
    const id = setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, countdown])

  const next = async () => {
    stopSnippet()
    const r = scoreWfd(sentence.words, typed)
    results.current.push({
      ref: sentence.id,
      exerciseId: sentence.exerciseId,
      expected: sentence.text,
      typed,
      correct: r.correct,
      total: r.total,
      kinds: r.words.map((w) => w.kind),
      typedWords: r.words.map((w) => w.typed ?? null),
      replays,
    })
    if (i + 1 < sentences.length) {
      setI(i + 1)
      setTyped('')
      setReplays(0)
      setProgress(0)
      setCountdown(mode === 'exam' ? settings.countdownSec : 3)
      setPhase('countdown')
      return
    }
    const now = Date.now()
    const items = results.current
    const a: ListeningAttempt = {
      id: newId(),
      task: 'wfd',
      exerciseId: sentences[0].exerciseId,
      mode,
      items,
      correct: items.reduce((n, x) => n + x.correct, 0),
      total: items.reduce((n, x) => n + x.total, 0),
      planId,
      startedAt: startedAt.current,
      completedAt: now,
      updatedAt: now,
    }
    await saveListeningAttempt(a, exerciseById)
    requestSync()
    navigate(`/listening/${a.id}`, { replace: true })
  }

  const statusPhase = phase === 'needs-tap' ? 'needs-tap' : phase === 'countdown' ? 'countdown' : phase === 'playing' ? 'playing' : 'ended'
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-4 pt-3 pb-6">
      <header className="flex items-center gap-2 pb-2">
        <Button variant="ghost" className="-ml-2 px-2" onClick={() => (window.confirm(t('player.exitConfirm')) ? navigate(-1) : undefined)} aria-label={t('player.exit')}>
          ←
        </Button>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-ink">Write From Dictation</div>
          <div className="text-xs text-ink-3">{t('fibl.mode', { mode: t(mode === 'exam' ? 'fibl.exam' : 'fibl.practice') })}</div>
        </div>
        <span className="text-sm text-ink-2 tabular-nums">{t('wfd.progress', { n: i + 1, total: sentences.length })}</span>
      </header>
      <p className="pb-3 text-[13px] leading-snug text-ink-2">You will hear a sentence. Type the sentence in the box below exactly as you hear it.</p>

      <StatusBox
        phase={statusPhase}
        mediaMs={progress * (sentence.endMs - sentence.startMs)}
        durationMs={sentence.endMs - sentence.startMs}
        countdown={countdown}
        volume={volume}
        onVolume={(v) => {
          setVolume(v)
          try {
            localStorage.setItem('hiw-volume', String(v))
          } catch {
            /* per-device convenience only */
          }
        }}
        onBegin={() => {
          unlockAudio()
          setPhase('countdown')
        }}
      />

      <textarea
        ref={input}
        {...RAW_INPUT}
        rows={3}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        disabled={phase === 'needs-tap'}
        className="mt-3 w-full rounded-lg border border-line-strong bg-surface p-3 font-[Arial,sans-serif] text-base text-ink focus:border-accent focus:outline-none"
        aria-label={t('wfd.answer')}
      />

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {mode === 'practice' && phase === 'ended' && (
            <Button
              className="px-3 py-1.5 text-sm"
              onClick={() => {
                setReplays((n) => n + 1)
                play()
              }}
            >
              ↻ {t('wfd.replay')}
            </Button>
          )}
          <span className="text-xs text-ink-3">{mode === 'exam' ? t('wfd.examNote') : t('wfd.practiceNote')}</span>
        </div>
        <Button variant={phase === 'ended' ? 'primary' : 'secondary'} className="min-w-28" onClick={() => void next()} disabled={phase === 'needs-tap' || phase === 'countdown'}>
          {t('player.next')}
        </Button>
      </div>
    </div>
  )
}
