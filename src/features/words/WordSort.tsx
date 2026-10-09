import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { requestSync } from '../../data/sync'
import { markWordsKnown, useWords, wordProgress } from '../../data/words'
import { currentPack, unmet } from '../../domain/words'
import { useI18n } from '../../i18n'
import { Button, ButtonLink, PageHeader } from '../../ui/kit'
import { shortZh } from './say'

const BATCH = 12

/**
 * Quick sort: tap the words you already know so rounds only spend time on new ones. The fastest way
 * through the easy part of the list.
 */
export function WordSortPage() {
  const { t } = useI18n()
  const [params] = useSearchParams()
  const words = useWords()
  const progress = useLiveQuery(() => wordProgress(), [], undefined)
  const [known, setKnown] = useState(new Set<string>())
  const [peek, setPeek] = useState(false)
  const [sorted, setSorted] = useState(0)
  /** Words already shown this visit (the ones left unticked are still to learn). */
  const [passed, setPassed] = useState(new Set<string>())

  const pack = params.get('pack') ? Number(params.get('pack')) : undefined
  const batch = useMemo(() => {
    if (!words || !progress) return null
    const list = words.data.words
    const from = pack ?? currentPack(list, progress)
    // From the chosen pack on, so a sorted-out pack carries on into the following ones.
    return unmet(list, progress)
      .filter((w) => w.pack >= from && !passed.has(w.w))
      .slice(0, BATCH)
  }, [words, progress, pack, passed])

  if (!batch) return <p className="p-6 text-ink-2">{t('common.loading')}</p>

  const toggle = (w: string) =>
    setKnown((s) => {
      const n = new Set(s)
      if (n.has(w)) n.delete(w)
      else n.add(w)
      return n
    })

  const submit = async () => {
    const chosen = batch.filter((w) => known.has(w.w))
    await markWordsKnown(chosen)
    requestSync()
    setSorted((n) => n + chosen.length)
    setPassed((s) => new Set([...s, ...batch.map((w) => w.w)]))
    setKnown(new Set())
    setPeek(false)
  }

  const learnPack = batch[0]?.pack
  return (
    <div className="space-y-4">
      <PageHeader title={`🧹 ${t('words.sortTitle')}`} sub={t('words.sortHow')} action={<ButtonLink to="/words">{t('words.back')}</ButtonLink>} />
      {sorted > 0 && <p className="rounded-lg bg-good-soft px-3 py-2 text-sm text-good">✓ {t('words.sortedSoFar', { n: sorted })}</p>}
      {batch.length === 0 ? (
        <p className="text-ink-2">{t('words.allDone')}</p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 text-xs text-ink-3">
            <span>{t('words.pack', { n: learnPack })}</span>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={peek} onChange={(e) => setPeek(e.target.checked)} />
              {t('words.showMeanings')}
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {batch.map((w) => {
              const on = known.has(w.w)
              return (
                <button
                  key={w.w}
                  onClick={() => toggle(w.w)}
                  aria-pressed={on}
                  className={`rounded-xl border-2 px-3 py-3 text-left transition-colors ${on ? 'border-good bg-good-soft' : 'border-line bg-surface hover:border-accent'}`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-lg font-medium text-ink">{w.w}</span>
                    {on && <span className="text-good">✓</span>}
                  </span>
                  {peek && <span className="mt-0.5 block text-xs text-ink-3">{shortZh(w.zh)}</span>}
                </button>
              )
            })}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button variant="primary" className="flex-1 py-3" onClick={() => void submit()}>
              {known.size ? t('words.sortSubmit', { n: known.size }) : t('words.sortNone')} →
            </Button>
            <ButtonLink className="py-3" to={`/words/play?pack=${learnPack}`}>
              {t('words.learnThese')}
            </ButtonLink>
          </div>
        </>
      )}
    </div>
  )
}
