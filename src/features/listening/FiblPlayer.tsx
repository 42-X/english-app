import { useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAppState } from '../../app/state'
import { newId } from '../../data/db'
import { saveListeningAttempt } from '../../data/repo'
import { requestSync } from '../../data/sync'
import { classifyAnswer, fiblBlanks } from '../../domain/listening'
import type { ListeningAttempt, Token } from '../../domain/types'
import { useI18n } from '../../i18n'
import { Button } from '../../ui/kit'
import { readVolume, StatusBox } from '../player/PlayerPage'
import { usePlayerSession } from '../player/usePlayerSession'

/** Exam-like keyboard behaviour: no autocorrect, no autocapitalise, no spellcheck. */
export const RAW_INPUT = { autoComplete: 'off', autoCorrect: 'off', autoCapitalize: 'none', spellCheck: false } as const

export function FiblPage() {
  const { id = '' } = useParams()
  const [params] = useSearchParams()
  const { exerciseById, ready } = useAppState()
  const { t } = useI18n()
  const ex = exerciseById.get(id)
  if (!ready) return <p className="p-6 text-ink-2">{t('common.loading')}</p>
  if (!ex) return <p className="p-6 text-ink-2">{t('player.notFound')}</p>
  return <FiblPlayer key={ex.id} exerciseId={ex.id} mode={params.get('mode') === 'exam' ? 'exam' : 'practice'} planId={params.get('plan') ?? undefined} />
}

function FiblPlayer({ exerciseId, mode, planId }: { exerciseId: string; mode: 'practice' | 'exam'; planId?: string }) {
  const { exerciseById, settings } = useAppState()
  const ex = exerciseById.get(exerciseId)!
  const { t } = useI18n()
  const navigate = useNavigate()
  // 'exam' mode for the session hook = no tracking checks or blackouts; FIB-L has no pause in the exam.
  const s = usePlayerSession(ex, 'exam', 1, settings.countdownSec, false)
  const blanks = useMemo(() => fiblBlanks(ex), [ex])
  const blankSet = useMemo(() => new Set(blanks), [blanks])
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [volume, setVolume] = useState(readVolume)
  const [saving, setSaving] = useState(false)
  const inputs = useRef<Record<number, HTMLInputElement | null>>({})
  const startedAt = useRef(Date.now())

  const focusNext = (i: number) => {
    const k = blanks.indexOf(i)
    const next = blanks[k + 1]
    if (next !== undefined) inputs.current[next]?.focus()
  }

  const submit = async () => {
    if (saving) return
    setSaving(true)
    const items = blanks.map((i) => {
      const expected = ex.tokens[i].spokenText
      const typed = answers[i] ?? ''
      const kind = classifyAnswer(expected, typed)
      return { ref: String(i), exerciseId: ex.id, expected, typed, correct: kind === 'correct' ? 1 : 0, total: 1, kinds: [kind] }
    })
    const now = Date.now()
    const a: ListeningAttempt = {
      id: newId(),
      task: 'fibl',
      exerciseId: ex.id,
      mode,
      items,
      correct: items.reduce((n, x) => n + x.correct, 0),
      total: items.length,
      planId,
      startedAt: startedAt.current,
      completedAt: now,
      updatedAt: now,
    }
    await saveListeningAttempt(a, exerciseById)
    requestSync()
    navigate(`/listening/${a.id}`, { replace: true })
  }

  const exit = () => {
    if (s.phase === 'needs-tap' || s.phase === 'loading' || window.confirm(t('player.exitConfirm'))) navigate(-1)
  }

  const renderToken = (tok: Token) => {
    if (!blankSet.has(tok.index)) return `${tok.leading}${tok.spokenText}${tok.trailing}`
    return (
      <>
        {tok.leading}
        <input
          ref={(el) => {
            inputs.current[tok.index] = el
          }}
          {...RAW_INPUT}
          // Same width for every gap, like the exam: the box must not hint at the word's length.
          aria-label={t('fibl.gap', { n: blanks.indexOf(tok.index) + 1 })}
          className="mx-0.5 inline-block h-[1.7em] w-[9.5ch] rounded border border-line-strong bg-surface px-1.5 py-0 align-baseline text-[0.95em] leading-none text-ink focus:border-accent focus:outline-none"
          value={answers[tok.index] ?? ''}
          disabled={s.phase === 'needs-tap' || s.phase === 'loading'}
          onChange={(e) => setAnswers((a) => ({ ...a, [tok.index]: e.target.value.replace(/\s+/g, '') }))}
          onFocus={(e) => e.currentTarget.scrollIntoView({ block: 'nearest', behavior: 'smooth' })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              focusNext(tok.index)
            }
          }}
        />
        {tok.trailing}
      </>
    )
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-4xl flex-col px-4 pt-3 pb-6">
      <header className="flex items-center gap-2 pb-2">
        <Button variant="ghost" className="-ml-2 px-2" onClick={exit} aria-label={t('player.exit')}>
          ←
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-ink">{mode === 'exam' ? 'Fill in the Blanks' : ex.title}</div>
          <div className="text-xs text-ink-3">{t('fibl.mode', { mode: t(mode === 'exam' ? 'fibl.exam' : 'fibl.practice') })}</div>
        </div>
        <span className="text-sm text-ink-2 tabular-nums">{t('fibl.filled', { n: blanks.filter((i) => answers[i]?.trim()).length, total: blanks.length })}</span>
      </header>
      <p className="pb-3 text-[13px] leading-snug text-ink-2">You will hear a recording. Type the missing words in each blank.</p>

      <StatusBox
        phase={s.phase}
        mediaMs={s.mediaMs}
        durationMs={ex.durationMs}
        countdown={s.countdown}
        volume={volume}
        onVolume={(v) => {
          setVolume(v)
          s.setVolume(v)
          try {
            localStorage.setItem('hiw-volume', String(v))
          } catch {
            /* per-device convenience only */
          }
        }}
        onBegin={s.begin}
      />

      <div className="transcript-exam mt-3 rounded-lg border border-line-strong bg-surface p-4 sm:p-6" style={{ lineHeight: 2.3 }}>
        {ex.tokens.map((tok) => (
          <span key={tok.index}>{renderToken(tok)} </span>
        ))}
      </div>

      <div className="mt-3 flex items-start justify-between gap-3">
        <p className="text-xs text-ink-3">{t('fibl.tip')}</p>
        <Button variant={s.phase === 'ended' ? 'primary' : 'secondary'} className="min-w-28 shrink-0" onClick={() => void submit()} disabled={saving || s.phase === 'needs-tap' || s.phase === 'loading'}>
          {t('player.next')}
        </Button>
      </div>
    </div>
  )
}
