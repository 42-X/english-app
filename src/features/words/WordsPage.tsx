import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { requestSync } from '../../data/sync'
import { unmarkWordKnown, useWords, wordProgress } from '../../data/words'
import { currentPack, isDueWord, isLearned, isLearning, packStats, planRound, type PackStats, type StudyWord, type WordProgress } from '../../domain/words'
import { useI18n } from '../../i18n'
import { Badge, Button, ButtonLink, Card, PageHeader, Stat } from '../../ui/kit'
import { WordSheet, type WordTarget } from '../vocab/WordSheet'
import { sayWord, shortZh } from './say'

/** PTE words: the exam's word list in 50-word packs, learned in short rounds. */
export function WordsPage() {
  const { t, lang } = useI18n()
  const words = useWords()
  const progress = useLiveQuery(() => wordProgress(), [], undefined)
  const [openPack, setOpenPack] = useState<number | null>(null)
  const [open, setOpen] = useState<WordTarget | null>(null)

  const view = useMemo(() => {
    if (!words || !progress) return null
    const now = Date.now()
    const list = words.data.words
    const all = [...progress.values()].filter((p) => words.byWord.has(p.id))
    const plan = planRound(list, progress, now)
    return {
      list,
      packs: packStats(list, progress),
      current: currentPack(list, progress),
      learned: all.filter(isLearned).length,
      learning: all.filter(isLearning).length,
      knew: all.filter((p) => p.knewAlready).length,
      due: all.filter((p) => !p.knewAlready && isDueWord(p, now)).length,
      plan,
      now,
    }
  }, [words, progress])

  if (!view || !progress) return <p className="p-6 text-ink-2">{t('common.loading')}</p>
  const shown = openPack ?? view.current

  return (
    <div className="space-y-4">
      <PageHeader title={`📚 ${t('words.title')}`} sub={t('words.sub', { n: view.list.length.toLocaleString(lang), packs: view.packs.length })} />

      <section className="rounded-xl border border-accent bg-accent-soft p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-lg font-semibold text-ink">{t('words.playTitle')}</div>
            <p className="mt-0.5 text-sm text-ink-2">{t('words.playSub', { review: view.plan.review.length, fresh: view.plan.fresh.length })}</p>
          </div>
          <ButtonLink variant="primary" className="py-3 text-base" to="/words/play">
            {t('words.play')} →
          </ButtonLink>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label={t('words.stat.learned')} value={view.learned} tone={view.learned ? 'good' : undefined} />
        <Stat label={t('words.stat.learning')} value={view.learning} />
        <Stat label={t('words.stat.knew')} value={view.knew} />
        <Stat label={t('words.stat.due')} value={view.due} />
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <Link to={`/words/sort?pack=${view.current}`} className="flex items-start gap-3 rounded-xl border border-line bg-surface p-4 hover:border-accent hover:bg-accent-soft">
          <span className="text-xl" aria-hidden>
            🧹
          </span>
          <span>
            <span className="block text-sm font-semibold text-ink">{t('words.sortTitle')}</span>
            <span className="mt-0.5 block text-xs text-ink-2">{t('words.sortSub')}</span>
          </span>
        </Link>
        <Link to="/words/match" className="flex items-start gap-3 rounded-xl border border-line bg-surface p-4 hover:border-accent hover:bg-accent-soft">
          <span className="text-xl" aria-hidden>
            ⚡
          </span>
          <span>
            <span className="block text-sm font-semibold text-ink">{t('words.matchTitle')}</span>
            <span className="mt-0.5 block text-xs text-ink-2">{t('words.matchSub')}</span>
          </span>
        </Link>
      </div>

      <Card title={t('words.packsTitle')}>
        <p className="-mt-2 mb-3 text-xs text-ink-3">{t('words.packsSub')}</p>
        <div className="grid grid-cols-8 gap-1.5 sm:grid-cols-10">
          {view.packs.map((p) => (
            <PackTile key={p.pack} p={p} current={p.pack === view.current} selected={p.pack === shown} onClick={() => setOpenPack(p.pack)} />
          ))}
        </div>
      </Card>

      <PackDetail pack={shown} list={view.list} progress={progress} now={view.now} onWord={(w) => setOpen({ word: w })} />

      {open && <WordSheet target={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

function PackTile({ p, current, selected, onClick }: { p: PackStats; current: boolean; selected: boolean; onClick: () => void }) {
  const { t } = useI18n()
  const done = (p.learned + p.knew) / p.total
  const started = (p.learned + p.knew + p.learning) / p.total
  const complete = done === 1
  return (
    <button
      onClick={onClick}
      aria-label={t('words.pack', { n: p.pack })}
      aria-pressed={selected}
      className={`relative flex aspect-square flex-col items-center justify-center overflow-hidden rounded-lg border text-xs tabular-nums ${
        selected ? 'border-accent ring-2 ring-accent/40' : current ? 'border-accent' : 'border-line'
      } ${complete ? 'bg-good-soft text-good' : 'bg-surface text-ink-2'}`}
    >
      <span className="absolute inset-x-0 bottom-0 bg-accent/15" style={{ height: `${started * 100}%` }} aria-hidden />
      <span className="absolute inset-x-0 bottom-0 bg-good/25" style={{ height: `${done * 100}%` }} aria-hidden />
      <span className="relative font-medium">{complete ? '✓' : p.pack}</span>
    </button>
  )
}

function PackDetail({ pack, list, progress, now, onWord }: { pack: number; list: StudyWord[]; progress: Map<string, WordProgress>; now: number; onWord: (w: string) => void }) {
  const { t, tk } = useI18n()
  const words = list.filter((w) => w.pack === pack)
  const s = packStats(words, progress)[0]
  if (!s) return null
  return (
    <Card
      title={t('words.pack', { n: pack })}
      action={
        <div className="flex gap-2">
          <ButtonLink className="px-3 py-1.5" to={`/words/sort?pack=${pack}`}>
            🧹 {t('words.sortShort')}
          </ButtonLink>
          <ButtonLink variant="primary" className="px-3 py-1.5" to={`/words/play?pack=${pack}`}>
            {t('words.playPack')}
          </ButtonLink>
        </div>
      }
    >
      <p className="-mt-2 mb-3 text-xs text-ink-3">{t('words.packSummary', { learned: s.learned, learning: s.learning, knew: s.knew, total: s.total })}</p>
      <ul className="divide-y divide-line">
        {words.map((w) => {
          const p = progress.get(w.w)
          const state = p?.knewAlready ? 'knew' : isLearned(p) ? 'learned' : isLearning(p) ? (isDueWord(p, now) ? 'due' : 'learning') : 'new'
          return (
            <li key={w.w} className="flex items-center gap-2 py-2">
              <button className="text-lg" onClick={() => sayWord(w.w)} aria-label={t('vocab.pronounce')}>
                🔊
              </button>
              <button className="min-w-0 flex-1 text-left" onClick={() => onWord(w.w)}>
                <span className="font-medium text-ink">{w.w}</span>
                <span className="ml-2 text-sm text-ink-2">{shortZh(w.zh)}</span>
                {w.ex && (
                  <span className="ml-1.5 text-xs" title={t('words.inPassage')} aria-label={t('words.inPassage')}>
                    🎧
                  </span>
                )}
              </button>
              {state === 'knew' ? (
                <Button variant="ghost" className="px-2 py-0.5 text-xs" onClick={() => void unmarkWordKnown(w).then(requestSync)} title={t('words.unknow')}>
                  <Badge>{t('words.state.knew')}</Badge>
                </Button>
              ) : (
                <Badge tone={state === 'learned' ? 'good' : state === 'new' ? 'neutral' : 'accent'}>{tk(`words.state.${state}`)}</Badge>
              )}
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
