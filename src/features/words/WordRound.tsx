import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAppState } from '../../app/state'
import { playRange, stopSnippet } from '../../audio/engine'
import { requestSync } from '../../data/sync'
import { markWordsKnown, meetWord, recordWordAnswer, saveWordRound, useWords, wordProgress, type WordAnswer } from '../../data/words'
import { sameWord } from '../../domain/listening'
import { buildQuestions, packStats, planRound, retryQuestion, seeded, sentenceAround, type Question, type StudyWord, type WordProgress } from '../../domain/words'
import { useI18n } from '../../i18n'
import { Button, ButtonLink } from '../../ui/kit'
import { RAW_INPUT } from '../listening/FiblPlayer'
import { WordSheet, type WordTarget } from '../vocab/WordSheet'
import { mainZh, sayWord, shortZh } from './say'

/** A short word round (~3 min): meet new words, then quick questions that mix in reviews. */
export function WordRoundPage() {
  const [params] = useSearchParams()
  const words = useWords()
  const { t } = useI18n()
  const pack = params.get('pack') ? Number(params.get('pack')) : undefined
  const [round, setRound] = useState(0)
  const [setup, setSetup] = useState<{ questions: Question[]; progress: Map<string, WordProgress> } | null>(null)

  // Progress is read once per round, so answering doesn't reshuffle the questions mid-round.
  useEffect(() => {
    if (!words) return
    let live = true
    void wordProgress().then((progress) => {
      if (!live) return
      const now = Date.now()
      const plan = planRound(words.data.words, progress, now, pack)
      setSetup({ questions: buildQuestions(plan, progress, words.data.words, seeded(now)), progress })
    })
    return () => {
      live = false
    }
  }, [words, pack, round])

  if (!words || !setup) return <p className="p-6 text-ink-2">{t('common.loading')}</p>
  if (setup.questions.length === 0) {
    return (
      <div className="mx-auto max-w-lg space-y-4 p-6 text-center">
        <p className="text-lg font-semibold text-ink">{t('words.allDone')}</p>
        <ButtonLink variant="primary" to="/words">
          {t('words.back')}
        </ButtonLink>
      </div>
    )
  }
  return <Round key={round} questions={setup.questions} words={words.data.words} onAgain={() => setRound((n) => n + 1)} />
}

function Round({ questions: initial, words, onAgain }: { questions: Question[]; words: StudyWord[]; onAgain: () => void }) {
  const { t } = useI18n()
  const { exerciseById } = useAppState()
  const navigate = useNavigate()
  const [queue, setQueue] = useState(initial)
  const [i, setI] = useState(0)
  const [picked, setPicked] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [hint, setHint] = useState(false)
  const [combo, setCombo] = useState(0)
  const [best, setBest] = useState(0)
  const [cheer, setCheer] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [answers, setAnswers] = useState<WordAnswer[]>([])
  const retried = useRef(new Set<string>())
  const [startedAt] = useState(() => Date.now())
  const rand = useMemo(() => seeded(startedAt + 1), [startedAt])
  const q = queue[i]

  const answered = picked !== null
  const correct = answered && (q.kind === 'spell' ? sameWord(q.answer, picked) : picked === q.answer)
  const ex = q?.word.ex ? exerciseById.get(q.word.ex[0]) : undefined
  const sentence = useMemo(() => (ex && q?.word.ex ? sentenceAround(ex, q.word.ex[1]) : null), [ex, q])

  // Say the word as each question appears (not when hearing it would give the answer away).
  useEffect(() => {
    if (!q) return
    if (q.kind === 'meet' || q.kind === 'meaning' || q.kind === 'listen' || q.kind === 'spell') sayWord(q.word.w)
    return stopSnippet
  }, [q])

  const finish = useCallback(async () => {
    setDone(true)
    stopSnippet()
    if (answers.length) {
      await saveWordRound(answers, startedAt)
      requestSync()
    }
  }, [answers, startedAt])

  const next = useCallback(
    (length = queue.length) => {
      stopSnippet()
      setPicked(null)
      setTyped('')
      setHint(false)
      if (i + 1 >= length) void finish()
      else setI(i + 1)
    },
    [i, queue.length, finish],
  )

  const answer = (value: string) => {
    if (answered || !q) return
    setPicked(value)
    const ok = q.kind === 'spell' ? sameWord(q.answer, value) : value === q.answer
    const isRetry = retried.current.has(q.word.w)
    setAnswers((xs) => [...xs, { word: q.word.w, typed: value, correct: ok }])
    // The first answer moves the word's schedule; a retry later in the round is practice.
    if (!isRetry) void recordWordAnswer(q.word, ok)
    if (ok) {
      const c = combo + 1
      setCombo(c)
      setBest((b) => Math.max(b, c))
      if (c === 3 || c === 5 || c % 10 === 0) setCheer(t('words.combo', { n: c }))
    } else {
      setCombo(0)
      if (!isRetry) {
        retried.current.add(q.word.w)
        const again = retryQuestion(q, words, rand)
        setQueue((xs) => [...xs.slice(0, i + 3), again, ...xs.slice(i + 3)])
      }
    }
    if (q.kind === 'context' && ex && sentence) void playRange(ex, sentence.startMs, sentence.endMs)
    else if (q.kind === 'reverse' || !ok) sayWord(q.word.w)
  }

  useEffect(() => {
    if (!cheer) return
    const id = setTimeout(() => setCheer(null), 1400)
    return () => clearTimeout(id)
  }, [cheer])

  const meet = async (knew: boolean) => {
    if (!knew) {
      await meetWord(q.word)
      return next()
    }
    await markWordsKnown([q.word])
    // Drop its question later in the round.
    const rest = queue.filter((x, k) => k <= i || x.word.w !== q.word.w)
    setQueue(rest)
    next(rest.length)
  }

  // Keyboard: 1–4 choose, Enter continues.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (done || !q || e.target instanceof HTMLInputElement) return
      if (!answered && q.options.length && /^[1-4]$/.test(e.key)) answer(q.options[Number(e.key) - 1])
      else if (answered && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault()
        next()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (done) return <Summary answers={answers} best={best} startedAt={startedAt} onAgain={onAgain} />

  const right = answers.filter((a) => a.correct).length
  return (
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col px-4 pt-3 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <header className="flex items-center gap-3">
        <button className="rounded-lg px-2 py-1 text-ink-3 hover:bg-surface-2 hover:text-ink" onClick={() => navigate('/words')} aria-label={t('common.close')}>
          ✕
        </button>
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2" aria-hidden>
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${(i / queue.length) * 100}%` }} />
        </div>
        <span className={`text-sm tabular-nums ${combo >= 3 ? 'font-semibold text-warn' : 'text-ink-3'}`}>{combo >= 3 ? `🔥 ${combo}` : `${i + 1}/${queue.length}`}</span>
        <span className="text-sm font-semibold text-ink tabular-nums">⭐ {right}</span>
      </header>

      {cheer && <div className="pointer-events-none fixed inset-x-0 top-16 z-30 mx-auto w-fit animate-bounce rounded-full bg-warn-soft px-4 py-1.5 text-sm font-semibold text-warn shadow">{cheer}</div>}

      <main className="flex flex-1 flex-col justify-center py-6">
        {q.kind === 'meet' ? (
          <MeetCard word={q.word} sentence={sentence} onPlay={() => ex && sentence && void playRange(ex, sentence.startMs, sentence.endMs)} onGotIt={() => void meet(false)} onKnew={() => void meet(true)} />
        ) : (
          <>
            <Prompt q={q} sentence={sentence} answered={answered} />
            {q.kind === 'spell' ? (
              <SpellInput q={q} typed={typed} setTyped={setTyped} answered={answered} correct={correct} hint={hint} onHint={() => setHint(true)} onSubmit={() => typed.trim() && answer(typed.trim())} />
            ) : (
              <div className={`mt-6 grid gap-2 ${q.kind === 'meaning' ? '' : 'sm:grid-cols-2'}`}>
                {q.options.map((o, k) => {
                  const isAnswer = o === q.answer
                  const tone = !answered ? 'border-line bg-surface hover:border-accent hover:bg-accent-soft' : isAnswer ? 'border-good bg-good-soft text-ink' : o === picked ? 'border-line-strong bg-surface-2 text-ink-3' : 'border-line bg-surface text-ink-3'
                  return (
                    <button
                      key={o}
                      disabled={answered}
                      onClick={() => answer(o)}
                      className={`flex min-h-14 items-center gap-3 rounded-xl border-2 px-4 py-3 text-left transition-colors ${tone}`}
                    >
                      <span className="hidden text-xs text-ink-3 sm:inline">{k + 1}</span>
                      <span className={q.kind === 'meaning' ? 'text-base' : 'text-lg font-medium'}>{q.kind === 'meaning' ? mainZh(o) : o}</span>
                      {answered && isAnswer && <span className="ml-auto text-good">✓</span>}
                    </button>
                  )
                })}
              </div>
            )}
            {answered && <Feedback q={q} correct={correct} picked={picked} />}
          </>
        )}
      </main>

      {answered && (
        <Button variant="primary" className="w-full py-3 text-base" onClick={() => next()} autoFocus>
          {i + 1 >= queue.length ? t('words.finish') : t('words.next')} →
        </Button>
      )}
    </div>
  )
}

function MeetCard({ word, sentence, onPlay, onGotIt, onKnew }: { word: StudyWord; sentence: ReturnType<typeof sentenceAround>; onPlay: () => void; onGotIt: () => void; onKnew: () => void }) {
  const { t } = useI18n()
  return (
    <div className="space-y-5">
      <div className="text-xs font-semibold tracking-wide text-accent uppercase">✨ {t('words.newWord')}</div>
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-4xl font-semibold tracking-tight text-ink">{word.w}</h1>
          <Button className="px-3 py-1.5" onClick={() => sayWord(word.w)} aria-label={t('vocab.pronounce')}>
            🔊
          </Button>
        </div>
        <div className="mt-1 text-sm text-ink-3">
          {word.p} {word.ipa && `/${word.ipa}/`}
        </div>
      </div>
      <div className="space-y-1">
        <p className="text-xl text-ink">{word.zh.split(' ／ ').map((line, k) => <span key={k} className="block">{line}</span>)}</p>
        {word.en && <p className="text-sm text-ink-2">{word.en}</p>}
      </div>
      {sentence && (
        <div className="rounded-xl bg-surface-2 p-4">
          <div className="mb-1 flex items-center justify-between gap-2 text-xs text-ink-3">
            <span>🎧 {t('words.inPassage')}</span>
            <button className="text-accent hover:underline" onClick={onPlay}>
              ▶ {t('words.hearIt')}
            </button>
          </div>
          <p className="text-base leading-relaxed text-ink">
            {sentence.before}
            <strong className="font-semibold text-accent">{sentence.word}</strong>
            {sentence.after}
          </p>
        </div>
      )}
      <div className="flex flex-col gap-2 pt-2 sm:flex-row">
        <Button variant="primary" className="flex-1 py-3 text-base" onClick={onGotIt} autoFocus>
          {t('words.gotIt')} →
        </Button>
        <Button variant="ghost" className="py-3" onClick={onKnew}>
          {t('words.knewIt')}
        </Button>
      </div>
    </div>
  )
}

function Prompt({ q, sentence, answered }: { q: Question; sentence: ReturnType<typeof sentenceAround>; answered: boolean }) {
  const { t } = useI18n()
  const speaker = (
    <button className="flex h-20 w-20 items-center justify-center rounded-full bg-accent text-3xl text-on-accent shadow-sm hover:bg-accent-strong" onClick={() => sayWord(q.word.w)} aria-label={t('words.playAgain')}>
      🔊
    </button>
  )
  switch (q.kind) {
    case 'meaning':
      return (
        <div>
          <div className="text-sm text-ink-3">{t('words.q.meaning')}</div>
          <div className="mt-2 flex items-center gap-3">
            <h1 className="text-4xl font-semibold tracking-tight text-ink">{q.word.w}</h1>
            <button className="text-2xl" onClick={() => sayWord(q.word.w)} aria-label={t('vocab.pronounce')}>
              🔊
            </button>
          </div>
        </div>
      )
    case 'listen':
    case 'spell':
      return (
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="text-sm text-ink-3">{t(q.kind === 'listen' ? 'words.q.listen' : 'words.q.spell')}</div>
          {speaker}
          <div className="text-xs text-ink-3">{t('words.tapToReplay')}</div>
        </div>
      )
    case 'reverse':
      return (
        <div>
          <div className="text-sm text-ink-3">{t('words.q.reverse')}</div>
          <p className="mt-2 text-2xl text-ink">{shortZh(q.word.zh)}</p>
          {q.word.en && <p className="mt-1 text-sm text-ink-2">{q.word.en}</p>}
        </div>
      )
    case 'context':
      return (
        <div>
          <div className="text-sm text-ink-3">{t('words.q.context')}</div>
          {sentence && (
            <p className="mt-3 text-lg leading-relaxed text-ink">
              {sentence.before}
              <span className={`inline-block min-w-20 rounded border-b-2 px-1 text-center ${answered ? 'border-good font-semibold text-good' : 'border-accent'}`}>{answered ? sentence.word : ' '}</span>
              {sentence.after}
            </p>
          )}
        </div>
      )
    default:
      return null
  }
}

function SpellInput({
  q,
  typed,
  setTyped,
  answered,
  correct,
  hint,
  onHint,
  onSubmit,
}: {
  q: Question
  typed: string
  setTyped: (s: string) => void
  answered: boolean
  correct: boolean
  hint: boolean
  onHint: () => void
  onSubmit: () => void
}) {
  const { t } = useI18n()
  return (
    <form
      className="mt-6 space-y-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (!answered) onSubmit()
      }}
    >
      <input
        {...RAW_INPUT}
        autoFocus
        disabled={answered}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={hint ? `${q.answer[0]}${' _'.repeat(q.answer.length - 1)}` : t('words.typeIt')}
        className={`w-full rounded-xl border-2 bg-surface px-4 py-3 text-center text-2xl text-ink focus:border-accent focus:outline-none ${answered ? (correct ? 'border-good' : 'border-line-strong') : 'border-line'}`}
      />
      {!answered && (
        <div className="flex gap-2">
          <Button type="submit" variant="primary" className="flex-1 py-3" disabled={!typed.trim()}>
            {t('words.check')}
          </Button>
          {!hint && (
            <Button type="button" variant="ghost" onClick={onHint}>
              💡 {t('words.hint')}
            </Button>
          )}
        </div>
      )}
    </form>
  )
}

function Feedback({ q, correct, picked }: { q: Question; correct: boolean; picked: string | null }) {
  const { t } = useI18n()
  return (
    <div className={`mt-5 rounded-xl p-4 ${correct ? 'bg-good-soft' : 'bg-surface-2'}`}>
      <div className={`text-sm font-semibold ${correct ? 'text-good' : 'text-ink'}`}>{correct ? `✓ ${t('words.right')}` : `↺ ${t('words.comesBack')}`}</div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
        <button className="text-xl font-semibold text-ink hover:underline" onClick={() => sayWord(q.word.w)}>
          {q.word.w} 🔊
        </button>
        <span className="text-ink-2">{mainZh(q.word.zh)}</span>
      </div>
      {!correct && q.kind === 'spell' && picked && <p className="mt-1 text-sm text-ink-2">{t('words.youTyped', { w: picked })}</p>}
      {!correct && q.kind !== 'spell' && q.kind !== 'meaning' && picked && picked !== q.answer && (
        <p className="mt-1 text-sm text-ink-2">{t('words.lookAlike', { w: picked })}</p>
      )}
    </div>
  )
}

function Summary({ answers, best, startedAt, onAgain }: { answers: WordAnswer[]; best: number; startedAt: number; onAgain: () => void }) {
  const { t } = useI18n()
  const words = useWords()
  const [progress, setProgress] = useState<Map<string, WordProgress> | null>(null)
  const [open, setOpen] = useState<WordTarget | null>(null)
  useEffect(() => {
    void wordProgress().then(setProgress)
  }, [])
  const right = answers.filter((a) => a.correct).length
  const seen = [...new Set(answers.map((a) => a.word))]
  const [minutes] = useState(() => Math.max(1, Math.round((Date.now() - startedAt) / 60_000)))
  const pack = words && progress ? packStats(words.data.words, progress).find((p) => p.learned + p.knew + p.learning < p.total) : undefined

  return (
    <div className="mx-auto max-w-xl space-y-5 px-4 py-8">
      <div className="text-center">
        <div className="text-5xl">🎉</div>
        <h1 className="mt-2 text-2xl font-semibold text-ink">{t('words.roundDone')}</h1>
        <p className="mt-1 text-3xl font-semibold text-accent tabular-nums">+{right} ⭐</p>
        <p className="mt-1 text-sm text-ink-2">{t('words.roundSub', { n: seen.length, min: minutes })}</p>
        {best >= 3 && <p className="mt-1 text-sm font-medium text-warn">🔥 {t('words.bestCombo', { n: best })}</p>}
      </div>

      {pack && (
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="mb-1 flex justify-between text-sm">
            <span className="font-medium text-ink">{t('words.pack', { n: pack.pack })}</span>
            <span className="text-ink-3 tabular-nums">
              {pack.learned + pack.knew + pack.learning}/{pack.total}
            </span>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full bg-good" style={{ width: `${((pack.learned + pack.knew) / pack.total) * 100}%`, float: 'left' }} />
            <div className="h-full bg-accent/50" style={{ width: `${(pack.learning / pack.total) * 100}%`, float: 'left' }} />
          </div>
          <p className="mt-1.5 text-xs text-ink-3">{t('words.packLegend')}</p>
        </div>
      )}

      {words && (
        <div className="flex flex-wrap gap-2">
          {seen.map((w) => {
            const s = words.byWord.get(w)
            return (
              <button key={w} onClick={() => setOpen({ word: w })} className="rounded-lg border border-line bg-surface px-3 py-1.5 text-left hover:border-accent">
                <span className="font-medium text-ink">{w}</span>
                {s && <span className="ml-1.5 text-xs text-ink-3">{shortZh(s.zh)}</span>}
              </button>
            )
          })}
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button variant="primary" className="flex-1 py-3 text-base" onClick={onAgain} autoFocus>
          {t('words.another')} →
        </Button>
        <ButtonLink className="py-3" to="/words/match">
          ⚡ {t('words.match')}
        </ButtonLink>
        <Link to="/words" className="self-center px-3 text-sm text-ink-2 hover:underline">
          {t('words.back')}
        </Link>
      </div>
      {open && <WordSheet target={open} onClose={() => setOpen(null)} />}
    </div>
  )
}
