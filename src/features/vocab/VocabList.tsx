import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState } from 'react'
import { useAppState } from '../../app/state'
import { backfillDefinitions, liveVocab, removeWord, setWordStatus } from '../../data/repo'
import { requestSync } from '../../data/sync'
import type { VocabEntry } from '../../domain/types'
import { nextMilestone } from '../../domain/vocab'
import { useI18n } from '../../i18n'
import { Badge, Button, Card, Segmented } from '../../ui/kit'
import { Replay } from '../results/ResultsPage'
import { chineseDictionaryUrl, pronounce, WordSheet, type WordTarget } from './WordSheet'

type Filter = 'learning' | 'known' | 'all'

export function VocabList() {
  const { t, lang } = useI18n()
  const { exerciseById } = useAppState()
  const words = useLiveQuery(() => liveVocab(), [], [])
  const [filter, setFilter] = useState<Filter>('learning')
  const [open, setOpen] = useState<WordTarget | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    void backfillDefinitions().then(requestSync)
  }, [])

  const known = words.filter((w) => w.status === 'known').length
  const learning = words.length - known
  const goal = nextMilestone(known)
  const prevGoal = [0, 5, 10, 25, 50, 100, 200, 300, 500].filter((m) => m <= known).pop() ?? 0
  const shown = words
    .filter((w) => filter === 'all' || w.status === filter)
    .sort((a, b) => (b.knownAt ?? b.addedAt) - (a.knownAt ?? a.addedAt))

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-3xl font-semibold text-ink tabular-nums">{known}</div>
            <div className="text-sm text-ink-2">{t('vocab.learnedCount', { learning })}</div>
          </div>
          {goal && (
            <div className="min-w-48 flex-1 sm:max-w-xs">
              <div className="mb-1 flex justify-between text-xs text-ink-3">
                <span>{t('vocab.nextGoal', { n: goal })}</span>
                <span className="tabular-nums">
                  {known}/{goal}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full rounded-full bg-good" style={{ width: `${((known - prevGoal) / (goal - prevGoal)) * 100}%` }} />
              </div>
            </div>
          )}
        </div>
        {words.length === 0 && <p className="mt-3 text-sm text-ink-2">{t('vocab.empty')}</p>}
        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (query.trim()) setOpen({ word: query.trim() })
          }}
        >
          <input
            className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
            placeholder={t('vocab.lookupPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
          />
          <Button type="submit">{t('vocab.lookUp')}</Button>
        </form>
      </Card>

      {words.length > 0 && (
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'learning', label: `${t('vocab.filter.learning')} (${learning})` },
            { value: 'known', label: `${t('vocab.filter.known')} (${known})` },
            { value: 'all', label: t('vocab.filter.all') },
          ]}
        />
      )}

      <ul className="space-y-2">
        {shown.map((w) => (
          <WordRow key={w.id} w={w} lang={lang} onOpen={() => setOpen({ word: w.id, context: w.context, exerciseId: w.exerciseId, tokenIndex: w.tokenIndex })} exerciseById={exerciseById} />
        ))}
      </ul>
      {open && <WordSheet target={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

function WordRow({ w, lang, onOpen, exerciseById }: { w: VocabEntry; lang: string; onOpen: () => void; exerciseById: ReturnType<typeof useAppState>['exerciseById'] }) {
  const { t } = useI18n()
  const ex = w.exerciseId ? exerciseById.get(w.exerciseId) : undefined
  const first = w.meanings[0]
  return (
    <li className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <button className="text-left" onClick={onOpen}>
          <span className="text-lg font-semibold text-ink">{w.word}</span>
          {w.phonetic && <span className="ml-2 text-sm text-ink-3">{w.phonetic}</span>}
        </button>
        <div className="flex items-center gap-1">
          <Button className="px-2.5 py-1 text-xs" onClick={() => pronounce(w.id, w.audioUrl)} aria-label={t('vocab.pronounce')}>
            🔊
          </Button>
          <a className="rounded-lg border border-line px-2.5 py-1 text-xs text-ink-2 hover:bg-surface-2" href={chineseDictionaryUrl(w.id)} target="_blank" rel="noreferrer">
            中文 ↗
          </a>
        </div>
      </div>
      {first ? (
        <p className="mt-1 text-sm text-ink">
          <span className="mr-1 text-xs text-ink-3">{first.partOfSpeech}</span>
          {first.definition}
        </p>
      ) : (
        <p className="mt-1 text-sm text-ink-3">{t('vocab.noDefinition')}</p>
      )}
      {w.context && <p className="mt-2 text-sm text-ink-2 italic">“{w.context}”</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {ex && w.tokenIndex !== undefined && <Replay ex={ex} index={w.tokenIndex} />}
        {w.status === 'learning' ? (
          <Button className="px-3 py-1 text-xs" onClick={() => void setWordStatus(w.id, 'known').then(requestSync)}>
            ✓ {t('vocab.markKnown')}
          </Button>
        ) : (
          <>
            <Badge tone="good">
              ✓ {t('vocab.known')} · {new Date(w.knownAt ?? w.addedAt).toLocaleDateString(lang, { month: 'short', day: 'numeric' })}
            </Badge>
            <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => void setWordStatus(w.id, 'learning').then(requestSync)}>
              {t('vocab.backToLearning')}
            </Button>
          </>
        )}
        <Button variant="ghost" className="ml-auto px-2 py-1 text-xs" onClick={() => void removeWord(w.id).then(requestSync)} aria-label={t('common.delete')}>
          ✕
        </Button>
      </div>
    </li>
  )
}
