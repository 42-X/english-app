import { useEffect, useMemo, useState } from 'react'
import { useAppState } from '../../app/state'
import { playSnippet, stopSnippet } from '../../audio/engine'
import { liveMistakes, reviewMistakeNow } from '../../data/repo'
import { requestSync } from '../../data/sync'
import { isDue, MASTERED, REVIEW_SESSION } from '../../domain/srs'
import type { MistakeItem } from '../../domain/types'
import { useI18n } from '../../i18n'
import { Badge, Button, ButtonLink, Card, PageHeader } from '../../ui/kit'
import { sameWord } from '../../domain/listening'
import { RAW_INPUT } from '../listening/FiblPlayer'
import { WordSheet, type WordTarget } from '../vocab/WordSheet'
import { useKeepGoing } from '../home/keepGoing'

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

  const keepGoing = useKeepGoing()
  const deal = () =>
    void liveMistakes().then((m) => {
      setDeck(order(m, Date.now()).slice(0, REVIEW_SESSION))
      setI(0)
      setResults([])
      setRevealed(false)
    })

  useEffect(() => {
    deal()
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
          <div className="text-2xl font-semibold text-ink">{ok >= results.length * 0.8 ? t('quick.doneGreat') : t('quick.doneOk')}</div>
          <p className="mt-1 text-sm text-ink-2">{t('quick.done', { ok, total: results.length })}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => void keepGoing()}>
              {t('home.keepGoing')} →
            </Button>
            <Button onClick={deal}>{t('quick.more')}</Button>
            <ButtonLink to="/">{t('results.backToPlan')}</ButtonLink>
          </div>
        </Card>
      </div>
    )
  }

  const fp = card.type === 'false-positive'
  if (card.type === 'spelling')
    return (
      <div className="space-y-4">
        <PageHeader title={t('mistakes.quickReview')} sub={t('quick.progress', { n: i + 1, total: deck.length })} />
        <SpellingCard key={card.id} card={card} parts={parts} onPlay={(r) => ex && void playSnippet(ex, card.tokenIndex, r)} hasAudio={!!ex} onGrade={(ok) => void grade(ok)} />
      </div>
    )
  return (
    <div className="space-y-4">
      <PageHeader title={t('mistakes.quickReview')} sub={t('quick.progress', { n: i + 1, total: deck.length })} />
      <Card>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={fp ? 'warn' : 'accent'}>{fp ? t('mistakes.type.false-positive') : t('mistakes.type.miss')}</Badge>
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

/** Spelling card: hear the word in context, type it; graded automatically. */
function SpellingCard({
  card,
  parts,
  onPlay,
  hasAudio,
  onGrade,
}: {
  card: MistakeItem
  parts: { before: string; word: string; after: string } | null
  onPlay: (rate: number) => void
  hasAudio: boolean
  onGrade: (ok: boolean) => void
}) {
  const { t } = useI18n()
  const [typed, setTyped] = useState('')
  const [checked, setChecked] = useState<boolean | null>(null)
  const check = () => setChecked(sameWord(card.spoken, typed))
  return (
    <Card>
      <Badge tone="warn">{t('mistakes.type.spelling')}</Badge>
      <p className="mt-4 text-lg leading-relaxed text-ink">
        …{parts?.before}
        <span className="mx-1 inline-block min-w-16 border-b-2 border-ink-3 text-center">{checked === null ? '\u00a0' : card.spoken}</span>
        {parts?.after}…
      </p>
      <p className="mt-2 text-sm text-ink-3">{t('quick.promptSpelling')}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {hasAudio ? (
          <>
            <Button onClick={() => onPlay(1)}>▶ {t('quick.play')}</Button>
            <Button onClick={() => onPlay(0.8)}>▶ 0.8×</Button>
          </>
        ) : (
          <span className="text-sm text-ink-3">{t('quick.noAudio')}</span>
        )}
      </div>
      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (checked === null) check()
        }}
      >
        <input
          {...RAW_INPUT}
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          disabled={checked !== null}
          className="min-w-0 flex-1 rounded-lg border border-line-strong bg-surface px-3 py-2 text-base text-ink focus:border-accent focus:outline-none"
          aria-label={t('quick.typeIt')}
          placeholder={t('quick.typeIt')}
        />
        {checked === null && (
          <Button variant="primary" type="submit" disabled={!typed.trim()}>
            {t('quick.check')}
          </Button>
        )}
      </form>
      {checked !== null && (
        <div className="mt-4 space-y-3">
          <div className={`rounded-lg px-4 py-3 text-base ${checked ? 'bg-good-soft text-good' : 'bg-bad-soft text-bad'}`}>
            {checked ? `✓ ${card.spoken}` : t('quick.spellingWrong', { typed, word: card.spoken })}
          </div>
          <Button variant="primary" className="w-full py-3" onClick={() => onGrade(checked)}>
            {t('player.next')} →
          </Button>
        </div>
      )}
    </Card>
  )
}
