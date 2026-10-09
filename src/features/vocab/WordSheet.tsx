import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState } from 'react'
import { db } from '../../data/db'
import { lookupWord, saveWord, setWordStatus } from '../../data/repo'
import { requestSync } from '../../data/sync'
import { useWords } from '../../data/words'
import { headword, type DictionaryResult } from '../../domain/vocab'
import { glossOf } from '../../domain/words'
import { useI18n } from '../../i18n'
import { Badge, Button } from '../../ui/kit'
import { sayWord, speak } from '../words/say'

export interface WordTarget {
  word: string
  /** The other word in an HIW pair (what was shown vs said), to hear them side by side. */
  compareWith?: string
  context?: string
  exerciseId?: string
  tokenIndex?: number
}

/** Speak a word: dictionary recording when available, otherwise the device's English voice. */
export function pronounce(word: string, audioUrl?: string): void {
  if (audioUrl) {
    void new Audio(audioUrl).play().catch(() => speak(word))
    return
  }
  speak(word)
}

/** Say several words one after another with a short pause, e.g. the shown word then the spoken one. */
export function pronounceInOrder(words: { word: string; audioUrl?: string }[], gapMs = 450): void {
  const [first, ...rest] = words
  if (!first) return
  const next = () => setTimeout(() => pronounceInOrder(rest, gapMs), rest.length ? gapMs : 0)
  if (first.audioUrl) {
    const a = new Audio(first.audioUrl)
    a.onended = next
    void a.play().catch(() => speak(first.word, next))
    return
  }
  speak(first.word, next)
}

/** Dictionary pronunciation URLs for some words, looked up ahead of time so playback starts on the tap. */
export function usePronunciations(words: readonly string[]): Map<string, string | undefined> {
  const key = words.map((w) => headword(w)).join('|')
  const [urls, setUrls] = useState(new Map<string, string | undefined>())
  useEffect(() => {
    let live = true
    void Promise.all(key.split('|').filter(Boolean).map(async (w) => [w, await lookupWord(w)] as const)).then((rs) => {
      if (live) setUrls(new Map(rs.map(([w, r]) => [w, r && r !== 'offline' ? r.audioUrl : undefined])))
    })
    return () => {
      live = false
    }
  }, [key])
  return urls
}

/**
 * Cambridge English–Chinese (Traditional) through its search, which opens the entry (plurals and past
 * forms included) or, for a word it doesn't have, a list of suggestions — never its home page.
 */
export function chineseDictionaryUrl(word: string): string {
  return `https://dictionary.cambridge.org/search/direct/?datasetsearch=english-chinese-traditional&q=${encodeURIComponent(headword(word))}`
}

/** Yahoo 奇摩字典: Traditional Chinese for almost any word, including specialist terms Cambridge lacks. */
export function yahooDictionaryUrl(word: string): string {
  return `https://tw.dictionary.search.yahoo.com/search?p=${encodeURIComponent(headword(word))}`
}

/** Bottom sheet with a word's pronunciation, definitions and "Add to My words". */
export function WordSheet({ target, onClose }: { target: WordTarget; onClose: () => void }) {
  const { t } = useI18n()
  const id = headword(target.word)
  const [dict, setDict] = useState<DictionaryResult | null | 'offline' | undefined>(undefined)
  const saved = useLiveQuery(() => db.vocab.get(id), [id])
  const inList = !!saved && !saved.deleted && !saved.source
  const words = useWords()
  const study = words?.byWord.get(id)
  const gloss = words ? glossOf(words.data, words.byWord, id) : null
  const pteWord = study ?? (gloss?.lemma ? words?.byWord.get(gloss.lemma) : undefined)
  const other = usePronunciations(target.compareWith ? [target.compareWith] : [])

  useEffect(() => {
    let live = true
    void lookupWord(id).then((r) => live && setDict(r))
    return () => {
      live = false
    }
  }, [id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const add = async () => {
    await saveWord(id, { context: target.context, exerciseId: target.exerciseId, tokenIndex: target.tokenIndex }, dict && dict !== 'offline' ? dict : null)
    requestSync()
  }

  const info = dict && dict !== 'offline' ? dict : null
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose} role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={target.word}
        className="max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-2xl font-semibold text-ink">{info?.word || id}</h2>
            {info?.phonetic && <div className="text-sm text-ink-2">{info.phonetic}</div>}
          </div>
          <Button variant="ghost" className="px-2" onClick={onClose} aria-label={t('common.close')}>
            ✕
          </Button>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <Button className="px-3 py-1.5" onClick={() => (study ? sayWord(id) : pronounce(id, info?.audioUrl))}>
            🔊 {t('vocab.pronounce')}
          </Button>
          {target.compareWith && (
            <Button className="px-3 py-1.5" onClick={() => pronounceInOrder([{ word: id, audioUrl: info?.audioUrl }, { word: target.compareWith!, audioUrl: other.get(headword(target.compareWith!)) }])}>
              🔊 {t('hear.compare', { w: target.compareWith })}
            </Button>
          )}
          <a className="inline-flex items-center rounded-lg border border-line px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-2" href={chineseDictionaryUrl(id)} target="_blank" rel="noreferrer">
            Cambridge 中文 ↗
          </a>
          <a className="inline-flex items-center rounded-lg border border-line px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-2" href={yahooDictionaryUrl(id)} target="_blank" rel="noreferrer">
            Yahoo 字典 ↗
          </a>
        </div>

        {gloss && (
          <div className="mt-4 rounded-lg bg-surface-2 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
              <span>中文</span>
              {gloss.lemma && <span>· {t('vocab.formOf', { w: gloss.lemma })}</span>}
              {pteWord && <Badge tone="accent">{t('vocab.pteWord', { n: pteWord.pack })}</Badge>}
            </div>
            <p className="mt-0.5 text-base text-ink">{gloss.zh}</p>
          </div>
        )}

        <div className="mt-4 space-y-3">
          {dict === undefined && <p className="text-sm text-ink-3">{t('common.loading')}</p>}
          {dict === 'offline' && <p className="text-sm text-ink-2">{t('vocab.offline')}</p>}
          {dict === null && <p className="text-sm text-ink-2">{t(gloss ? 'vocab.notFoundEn' : 'vocab.notFound')}</p>}
          {info?.meanings.map((m, i) => (
            <div key={i}>
              <div className="text-xs font-medium tracking-wide text-ink-3 uppercase">{m.partOfSpeech}</div>
              <p className="text-sm leading-relaxed text-ink">{m.definition}</p>
              {m.example && <p className="text-sm text-ink-2 italic">“{m.example}”</p>}
            </div>
          ))}
          {target.context && (
            <div className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink-2">
              <div className="mb-0.5 text-xs text-ink-3">{t('vocab.inContext')}</div>
              {target.context}
            </div>
          )}
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          {!inList ? (
            <Button variant="primary" onClick={() => void add()} disabled={dict === undefined}>
              ＋ {t('vocab.add')}
            </Button>
          ) : (
            <>
              <Badge tone="good">✓ {t('vocab.inList')}</Badge>
              {saved.status === 'learning' ? (
                <Button className="px-3 py-1.5" onClick={() => void setWordStatus(id, 'known').then(requestSync)}>
                  {t('vocab.markKnown')}
                </Button>
              ) : (
                <Badge tone="accent">{t('vocab.known')}</Badge>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
