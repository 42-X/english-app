import { Button } from '../../ui/kit'
import { useI18n } from '../../i18n'
import type { Exercise } from '../../domain/types'
import { headword } from '../../domain/vocab'
import { pronounce, pronounceInOrder, usePronunciations, type WordTarget } from '../vocab/WordSheet'
import { Replay } from './ResultsPage'

/**
 * Study one HIW pair: hear the word that was on screen and the word that was said (alone or back to
 * back), replay it in the recording, and look up either word.
 */
export function HearDifference({
  shown,
  said,
  ex,
  index,
  context,
  onLookUp,
}: {
  shown: string
  said: string
  ex?: Exercise
  index: number
  context?: string
  onLookUp: (w: WordTarget) => void
}) {
  const { t } = useI18n()
  const urls = usePronunciations([shown, said])
  const a = { word: shown, audioUrl: urls.get(headword(shown)) }
  const b = { word: said, audioUrl: urls.get(headword(said)) }
  const label = 'w-24 shrink-0 text-xs text-ink-3'
  const small = 'px-2.5 py-1 text-xs'
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={label}>{t('hear.say')}</span>
        <Button className={small} onClick={() => pronounce(a.word, a.audioUrl)} title={t('hear.shown')}>
          🔊 <span className="line-through decoration-ink-3">{shown}</span>
        </Button>
        <Button className={small} onClick={() => pronounce(b.word, b.audioUrl)} title={t('hear.said')}>
          🔊 <span className="font-semibold">{said}</span>
        </Button>
        <Button className={small} variant="primary" onClick={() => pronounceInOrder([a, b])}>
          🔊 {t('hear.both')}
        </Button>
      </div>
      {ex && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={label}>{t('hear.recording')}</span>
          <Replay ex={ex} index={index} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={label}>{t('hear.lookUp')}</span>
        <Button className={small} onClick={() => onLookUp({ word: shown, compareWith: said, context, exerciseId: ex?.id, tokenIndex: index })}>
          {shown}
        </Button>
        <Button className={small} onClick={() => onLookUp({ word: said, compareWith: shown, context, exerciseId: ex?.id, tokenIndex: index })}>
          {said}
        </Button>
      </div>
    </div>
  )
}
