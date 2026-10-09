import { useLiveQuery } from 'dexie-react-hooks'
import { useWords, wordProgress } from '../../data/words'
import { currentPack, isDueWord, isLearned, packStats } from '../../domain/words'
import { useI18n } from '../../i18n'
import { ButtonLink } from '../../ui/kit'

/** Home: where she is in the PTE word list and a one-tap round. */
export function WordsCard() {
  const { t } = useI18n()
  const words = useWords()
  const progress = useLiveQuery(() => wordProgress(), [], undefined)
  if (!words || !progress) return null
  const now = Date.now()
  const rows = [...progress.values()].filter((p) => words.byWord.has(p.id))
  const due = rows.filter((p) => !p.knewAlready && isDueWord(p, now)).length
  const learned = rows.filter(isLearned).length
  const pack = currentPack(words.data.words, progress)
  const s = packStats(
    words.data.words.filter((w) => w.pack === pack),
    progress,
  )[0]
  const started = rows.length > 0
  return (
    <section className="rounded-xl border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-ink">📚 {t('words.title')}</h2>
          <p className="mt-0.5 text-sm text-ink-2">{started ? t('words.cardSub', { learned, due }) : t('words.cardIntro')}</p>
          {s && (
            <div className="mt-2 max-w-xs">
              <div className="mb-1 flex justify-between text-xs text-ink-3">
                <span>{t('words.pack', { n: pack })}</span>
                <span className="tabular-nums">
                  {s.learned + s.knew}/{s.total}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full rounded-full bg-good" style={{ width: `${((s.learned + s.knew) / s.total) * 100}%` }} />
              </div>
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <ButtonLink to="/words">{t('words.open')}</ButtonLink>
          <ButtonLink variant="primary" to="/words/play">
            {t('words.play')} →
          </ButtonLink>
        </div>
      </div>
    </section>
  )
}
