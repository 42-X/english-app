import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAppState } from '../../app/state'
import { playRange, playSnippet, stopSnippet } from '../../audio/engine'
import { db } from '../../data/db'
import { recentListening } from '../../data/repo'
import { listeningMood } from '../../domain/momentum'
import { extractWfd, listeningCoaching, type AnswerKind } from '../../domain/listening'
import type { Exercise, ListeningAttempt } from '../../domain/types'
import { useCoachText, useI18n } from '../../i18n'
import { Badge, Button, Card, Stat } from '../../ui/kit'
import { NextActions } from '../results/ResultsPage'
import { WordSheet, type WordTarget } from '../vocab/WordSheet'

const KIND_STYLE: Record<AnswerKind, string> = {
  correct: 'bg-good-soft text-good',
  ending: 'bg-warn-soft text-warn',
  spelling: 'bg-warn-soft text-warn',
  wrong: 'bg-bad-soft text-bad',
  blank: 'bg-bad-soft text-bad',
}

export function ListeningResultsPage() {
  const { id = '' } = useParams()
  const a = useLiveQuery(() => db.listening.get(id), [id])
  const { ready } = useAppState()
  const { t } = useI18n()
  if (a === undefined || !ready) return <p className="p-6 text-ink-2">{t('common.loading')}</p>
  return <Results a={a} />
}

function Results({ a }: { a: ListeningAttempt }) {
  const { t, tk } = useI18n()
  const coach = useCoachText()
  const { exerciseById, exercises } = useAppState()
  const [word, setWord] = useState<WordTarget | null>(null)
  const history = useLiveQuery(() => recentListening(a.task, 40), [a.task])
  const mood = history && listeningMood(a, history)
  // The score line is shown as the headline; the rest are tips.
  const tips = listeningCoaching(a).filter((l) => l.key !== 'lst.score')
  useEffect(() => stopSnippet, [])

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 px-4 py-5">
      <header>
        <p className="text-sm text-ink-3">
          {a.task === 'fibl' ? 'Fill in the Blanks' : 'Write From Dictation'} · {t(a.mode === 'exam' ? 'fibl.exam' : 'fibl.practice')}
        </p>
        <h1 className="text-xl font-semibold text-ink">{a.task === 'fibl' ? exerciseById.get(a.exerciseId)?.title : t('wfd.setTitle', { n: a.items.length })}</h1>
      </header>

      <Card>
        {mood && <div className="text-2xl font-semibold text-ink">{tk(`mood.${mood}`)}</div>}
        <p className="mt-1 text-sm text-ink-2">
          {t('lst.caught', { correct: a.correct, total: a.total })} {t('lst.noPenalty')}
        </p>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label={t('lst.points')} value={`${a.correct}/${a.total}`} tone={a.correct > 0 ? 'good' : undefined} />
          <Stat label={t('lst.accuracy')} value={`${Math.round((a.correct / Math.max(1, a.total)) * 100)}%`} />
        </div>
        {tips.length > 0 && (
          <div className="mt-4 rounded-lg bg-accent-soft px-3 py-2.5">
            <div className="text-xs font-semibold text-accent">💡 {t('results.tipTitle')}</div>
            <div className="mt-1 space-y-1">
              {tips.slice(0, 2).map((l, i) => (
                <p key={i} className="text-sm leading-relaxed text-ink">
                  {coach(l.key, l.params)}
                </p>
              ))}
            </div>
          </div>
        )}
        <NextActions attempt={a} className="mt-4" celebrate />
        <p className="mt-3 text-xs text-ink-3">{t('lst.scoring')}</p>
      </Card>

      {a.task === 'fibl' ? <FiblReview a={a} onWord={setWord} /> : <WfdReview a={a} exercises={exercises} onWord={setWord} />}

      <NextActions attempt={a} className="pb-4" retryTo={a.task === 'fibl' ? `/fibl/${a.exerciseId}?mode=${a.mode}` : `/wfd?mode=${a.mode}`} />
      {word && <WordSheet target={word} onClose={() => setWord(null)} />}
    </div>
  )
}

function KindBadge({ kind }: { kind: AnswerKind }) {
  const { tk } = useI18n()
  return <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${KIND_STYLE[kind]}`}>{tk(`lst.kind.${kind}`)}</span>
}

function FiblReview({ a, onWord }: { a: ListeningAttempt; onWord: (w: WordTarget) => void }) {
  const { t } = useI18n()
  const { exerciseById } = useAppState()
  const ex = exerciseById.get(a.exerciseId)
  const byIndex = new Map(a.items.map((it) => [Number(it.ref), it]))
  if (!ex) return null
  return (
    <>
      <Card title={t('fibl.blanks')}>
        <ul className="divide-y divide-line">
          {a.items.map((it) => (
            <li key={it.ref} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
              <div className="min-w-40 flex-1">
                <span className="font-semibold text-ink">{it.expected}</span>
                {it.kinds[0] !== 'correct' && <span className="ml-2 text-sm text-ink-3">{it.typed ? t('lst.youTyped', { w: it.typed }) : t('lst.empty')}</span>}
              </div>
              <KindBadge kind={it.kinds[0]} />
              <div className="flex gap-1">
                {[0.8, 1].map((r) => (
                  <Button key={r} className="px-2.5 py-1 text-xs" onClick={() => void playSnippet(ex, Number(it.ref), r)}>
                    ▶ {r}×
                  </Button>
                ))}
                <Button className="px-2.5 py-1 text-xs" onClick={() => onWord({ word: it.expected, exerciseId: ex.id, tokenIndex: Number(it.ref) })}>
                  {t('hear.lookUp')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Card>
      <Card title={t('results.transcript')}>
        <p className="transcript-training leading-[2.2]!">
          {ex.tokens.map((tok) => {
            const it = byIndex.get(tok.index)
            return (
              <span key={tok.index}>
                {tok.leading}
                {it ? (
                  <span className={`word ${it.kinds[0] === 'correct' ? 'word-hit' : 'word-miss'}`}>
                    {tok.spokenText}
                    {it.kinds[0] !== 'correct' && <sup className="ml-0.5 text-[0.7em] text-ink-2">{it.typed || '—'}</sup>}
                  </span>
                ) : (
                  tok.spokenText
                )}
                {tok.trailing}{' '}
              </span>
            )
          })}
        </p>
      </Card>
    </>
  )
}

function WfdReview({ a, exercises, onWord }: { a: ListeningAttempt; exercises: Exercise[]; onWord: (w: WordTarget) => void }) {
  const { t } = useI18n()
  const { exerciseById } = useAppState()
  const sentences = useMemo(() => new Map(extractWfd(exercises).map((s) => [s.id, s])), [exercises])
  return (
    <Card title={t('wfd.sentences')}>
      <ul className="divide-y divide-line">
        {a.items.map((it) => {
          const s = sentences.get(it.ref)
          const ex = exerciseById.get(it.exerciseId)
          const from = Number(it.ref.split(':').pop())
          return (
            <li key={it.ref} className="space-y-2 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-ink tabular-nums">
                  {it.correct}/{it.total}
                  {it.replays ? <span className="ml-2 text-xs text-ink-3">{t('wfd.replays', { n: it.replays })}</span> : null}
                </span>
                {ex && s && (
                  <Button className="px-2.5 py-1 text-xs" onClick={() => void playRange(ex, s.startMs, s.endMs)}>
                    ▶ {t('wfd.replay')}
                  </Button>
                )}
              </div>
              <p className="leading-loose">
                {(s?.words ?? it.expected.split(' ')).map((w, k) => (
                  <span key={k}>
                    <button
                      className={`rounded px-1 ${KIND_STYLE[it.kinds[k] ?? 'blank']}`}
                      title={it.kinds[k] !== 'correct' ? (it.typedWords?.[k] ?? '—') : undefined}
                      onClick={() => onWord({ word: w, exerciseId: it.exerciseId, tokenIndex: from + k, context: it.expected })}
                    >
                      {w}
                      {it.kinds[k] !== 'correct' && it.typedWords?.[k] && <sup className="ml-0.5 text-[0.7em] opacity-80">{it.typedWords[k]}</sup>}
                    </button>{' '}
                  </span>
                ))}
              </p>
              <p className="text-sm text-ink-3">
                {t('lst.youTyped', { w: it.typed || '—' })}
              </p>
            </li>
          )
        })}
      </ul>
      <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
        {(['correct', 'ending', 'spelling', 'wrong', 'blank'] as const).map((k) => (
          <KindBadge key={k} kind={k} />
        ))}
      </div>
      <p className="mt-2 text-xs text-ink-3">
        <Link to="/mistakes" className="underline">
          {t('lst.bankNote')}
        </Link>
      </p>
      <Badge>{t('vocab.tapHint')}</Badge>
    </Card>
  )
}
