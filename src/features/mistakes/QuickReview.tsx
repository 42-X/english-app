import { useEffect, useMemo, useState } from 'react'
import { useAppState } from '../../app/state'
import { playSnippet, stopSnippet } from '../../audio/engine'
import { liveMistakes, reviewMistakeNow } from '../../data/repo'
import { requestSync } from '../../data/sync'
import { isDue, MASTERED } from '../../domain/srs'
import type { MistakeItem } from '../../domain/types'
import { useI18n } from '../../i18n'
import { Badge, Button, ButtonLink, Card, PageHeader } from '../../ui/kit'
import { WordSheet, type WordTarget } from '../vocab/WordSheet'

const SESSION_SIZE = 12

/** Due items first, then the least-practised; mastered items last. */
function order(items: MistakeItem[], now: number): MistakeItem[] {
  return [...items].sort((a, b) => {
    const rank = (m: MistakeItem) => (isDue(m, now) ? 0 : m.step >= MASTERED ? 2 : 1)
    return rank(a) - rank(b) || a.step - b.step || a.dueAt - b.dueAt
  })
}

/** Flashcard review of missed / wrongly-clicked words, each with its audio clip. */
export function QuickReview() {
  const { t, tk } = useI18n()
  const { exerciseById } = useAppState()
  const [deck, setDeck] = useState<MistakeItem[] | null>(null)
  const [i, setI] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [results, setResults] = useState<boolean[]>([])
  const [word, setWord] = useState<WordTarget | null>(null)

  useEffect(() => {
    void liveMistakes().then((m) => setDeck(order(m, Date.now()).slice(0, SESSION_SIZE)))
    return stopSnippet
  }, [])

  const card = deck?.[i]
  const ex = card ? exerciseById.get(card.exerciseId) : undefined

  // Play the clip as each card appears.
  useEffect(() => {
    if (ex && card) void playSnippet(ex, card.tokenIndex, 1)
  }, [ex, card])

  const parts = useMemo(() => {
    if (!card) return null
    const m = card.context.match(/^(.*)\[(.+?)\](.*)$/)
    return m ? { before: m[1], word: m[2], after: m[3] } : { before: '', word: card.display, after: '' }
  }, [card])

  const grade = async (ok: boolean) => {
    if (!card) return
    await reviewMistakeNow(card.id, ok)
    requestSync()
    setResults((r) => [...r, ok])
    setRevealed(false)
    setI((n) => n + 1)
  }

  if (deck === null) return <p className="p-6 text-ink-2">{t('common.loading')}</p>
  if (deck.length === 0)
    return (
      <div className="space-y-4">
        <PageHeader title={t('mistakes.quickReview')} />
        <Card>
          <p className="text-sm text-ink-2">{t('mistakes.empty')}</p>
        </Card>
      </div>
    )

  if (!card) {
    const ok = results.filter(Boolean).length
    return (
      <div className="space-y-4">
        <PageHeader title={t('mistakes.quickReview')} />
        <Card>
          <div className="text-3xl font-semibold text-ink">
            {ok}/{results.length}
          </div>
          <p className="mt-1 text-sm text-ink-2">{t('quick.done', { ok, total: results.length })}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <ButtonLink variant="primary" to="/mistakes">
              {t('quick.backToBank')}
            </ButtonLink>
            <ButtonLink to="/mistakes?tab=words">{t('review.tab.words')}</ButtonLink>
          </div>
        </Card>
      </div>
    )
  }

  const fp = card.type === 'false-positive'
  return (
    <div className="space-y-4">
      <PageHeader title={t('mistakes.quickReview')} sub={t('quick.progress', { n: i + 1, total: deck.length })} />
      <Card>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={fp ? 'warn' : 'bad'}>{fp ? t('mistakes.type.false-positive') : t('mistakes.type.miss')}</Badge>
          {card.trapCategory && <Badge>{tk(`trap.${card.trapCategory}`)}</Badge>}
        </div>
        <p className="mt-4 text-lg leading-relaxed text-ink">
          …{parts?.before}
          <mark className="rounded bg-[var(--select)] px-1 text-[var(--select-ink)]">{parts?.word}</mark>
          {parts?.after}…
        </p>
        <p className="mt-2 text-sm text-ink-3">{fp ? t('quick.promptFp') : t('quick.prompt')}</p>

        <div className="mt-4 flex flex-wrap gap-2">
          {ex ? (
            <>
              <Button onClick={() => void playSnippet(ex, card.tokenIndex, 1)}>▶ {t('quick.play')}</Button>
              <Button onClick={() => void playSnippet(ex, card.tokenIndex, 0.8)}>▶ 0.8×</Button>
            </>
          ) : (
            <span className="text-sm text-ink-3">{t('quick.noAudio')}</span>
          )}
        </div>

        {!revealed ? (
          <Button variant="primary" className="mt-5 w-full py-3" onClick={() => setRevealed(true)}>
            {t('quick.show')}
          </Button>
        ) : (
          <div className="mt-5 space-y-4">
            <div className="rounded-lg bg-surface-2 px-4 py-3 text-base">
              {fp ? (
                t('quick.answerFp', { word: card.display })
              ) : (
                <>
                  <span className="text-ink-3 line-through">{card.display}</span>
                  <span className="mx-2 text-ink-3">→</span>
                  <span className="font-semibold text-ink">{card.spoken}</span>
                  <span className="ml-2 text-sm text-ink-3">{t('quick.spoken')}</span>
                </>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button className="py-3" onClick={() => void grade(false)}>
                ✗ {t('quick.hard')}
              </Button>
              <Button variant="primary" className="py-3" onClick={() => void grade(true)}>
                ✓ {t('quick.gotIt')}
              </Button>
            </div>
            <Button variant="ghost" className="w-full" onClick={() => setWord({ word: card.spoken, context: card.context.replace(/[[\]]/g, ''), exerciseId: card.exerciseId, tokenIndex: card.tokenIndex })}>
              📖 {t('quick.dontKnow')}
            </Button>
          </div>
        )}
      </Card>
      {word && <WordSheet target={word} onClose={() => setWord(null)} />}
    </div>
  )
}
