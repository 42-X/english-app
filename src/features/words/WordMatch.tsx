import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getMeta, setMeta } from '../../data/db'
import { requestSync } from '../../data/sync'
import { saveWordRound, useWords, wordProgress, type WordAnswer } from '../../data/words'
import { currentPack, isLearning, seeded, shuffle, unmet, type StudyWord } from '../../domain/words'
import { useI18n } from '../../i18n'
import { Button } from '../../ui/kit'
import { sayWord, shortZh } from './say'

const PAIRS = 6
const BEST_KEY = 'words:matchBest'

/** Speed match: pair English words with their meanings against the clock. Only her own best time to beat. */
export function WordMatchPage() {
  const words = useWords()
  const { t } = useI18n()
  const [game, setGame] = useState(0)
  const [set, setSet] = useState<StudyWord[] | null>(null)

  useEffect(() => {
    if (!words) return
    void wordProgress().then((progress) => {
      const list = words.data.words
      const rand = seeded(Date.now())
      // Words she is learning first, then the current pack's new ones.
      const learning = shuffle(
        list.filter((w) => isLearning(progress.get(w.w))),
        rand,
      )
      const fresh = unmet(list, progress, currentPack(list, progress))
      setSet([...learning, ...fresh, ...list].filter((w, k, a) => a.findIndex((x) => x.w === w.w) === k).slice(0, PAIRS))
    })
  }, [words, game])

  if (!set) return <p className="p-6 text-ink-2">{t('common.loading')}</p>
  return <Board key={game} set={set} onAgain={() => setGame((n) => n + 1)} />
}

function Board({ set, onAgain }: { set: StudyWord[]; onAgain: () => void }) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const rand = useMemo(() => seeded(Date.now()), [])
  const left = useMemo(() => shuffle(set, rand), [set, rand])
  const right = useMemo(() => shuffle(set, rand), [set, rand])
  const [sel, setSel] = useState<{ side: 'en' | 'zh'; w: string } | null>(null)
  const [matched, setMatched] = useState(new Set<string>())
  const [shake, setShake] = useState<string | null>(null)
  const [start, setStart] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [best, setBest] = useState<number | null>(null)
  const [newBest, setNewBest] = useState(false)
  const [missed, setMissed] = useState(new Set<string>())
  const finished = matched.size === set.length

  useEffect(() => {
    void getMeta<number>(BEST_KEY).then((b) => setBest(b ?? null))
  }, [])

  useEffect(() => {
    if (start === null || finished) return
    const id = setInterval(() => setElapsed(Date.now() - start), 100)
    return () => clearInterval(id)
  }, [start, finished])

  /** The board is cleared: time, personal best, and the round saved like any other. */
  const finish = (startedAt: number) => {
    const ms = Date.now() - startedAt
    setElapsed(ms)
    if (best === null || ms < best) {
      setNewBest(best !== null)
      setBest(ms)
      void setMeta(BEST_KEY, ms)
    }
    const answers: WordAnswer[] = set.map((w) => ({ word: w.w, typed: w.w, correct: !missed.has(w.w) }))
    void saveWordRound(answers, startedAt).then(requestSync)
  }

  const tap = (side: 'en' | 'zh', w: string) => {
    if (matched.has(w)) return
    const t0 = start ?? Date.now()
    if (start === null) setStart(t0)
    if (side === 'en') sayWord(w)
    if (!sel || sel.side === side) return setSel({ side, w })
    if (sel.w === w) {
      const now = new Set([...matched, w])
      setMatched(now)
      setSel(null)
      if (now.size === set.length) finish(t0)
      return
    }
    setMissed((m) => new Set([...m, w, sel.w]))
    setShake(`${side}:${w}`)
    setTimeout(() => setShake(null), 400)
    setSel(null)
  }

  const tile = (side: 'en' | 'zh', w: StudyWord) => {
    const done = matched.has(w.w)
    const on = sel?.side === side && sel.w === w.w
    return (
      <button
        key={`${side}:${w.w}`}
        disabled={done}
        onClick={() => tap(side, w.w)}
        className={`min-h-14 w-full rounded-xl border-2 px-3 py-2 text-left transition-all ${done ? 'border-good/40 bg-good-soft opacity-40' : on ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:border-accent'} ${
          shake === `${side}:${w.w}` ? 'translate-x-1' : ''
        }`}
      >
        <span className={side === 'en' ? 'text-base font-medium text-ink' : 'text-sm text-ink'}>{side === 'en' ? w.w : shortZh(w.zh)}</span>
      </button>
    )
  }

  const secs = (ms: number) => (ms / 1000).toFixed(1)
  return (
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col px-4 pt-3 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <header className="flex items-center gap-3">
        <button className="rounded-lg px-2 py-1 text-ink-3 hover:bg-surface-2 hover:text-ink" onClick={() => navigate('/words')} aria-label={t('common.close')}>
          ✕
        </button>
        <h1 className="flex-1 text-base font-semibold text-ink">⚡ {t('words.matchTitle')}</h1>
        <span className="text-sm text-ink tabular-nums">⏱ {secs(elapsed)} s</span>
        {best !== null && <span className="text-xs text-ink-3 tabular-nums">{t('words.matchBest', { s: secs(best) })}</span>}
      </header>

      {!finished ? (
        <>
          <p className="mt-4 text-sm text-ink-2">{t('words.matchHow')}</p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-2">{left.map((w) => tile('en', w))}</div>
            <div className="flex flex-col gap-2">{right.map((w) => tile('zh', w))}</div>
          </div>
        </>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <div className="text-5xl">{newBest ? '🏆' : '⚡'}</div>
          <div className="text-2xl font-semibold text-ink tabular-nums">{secs(elapsed)} s</div>
          <p className="text-sm text-ink-2">{newBest ? t('words.matchNewBest') : t('words.matchDone', { n: set.filter((w) => !missed.has(w.w)).length, total: set.length })}</p>
          <div className="mt-2 flex gap-2">
            <Button variant="primary" className="py-3" onClick={onAgain} autoFocus>
              {t('words.matchAgain')} →
            </Button>
            <Button className="py-3" onClick={() => navigate('/words')}>
              {t('words.back')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
