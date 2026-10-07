import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAppState } from '../../app/state'
import { deleteMistake, liveMistakes, recentAttempts } from '../../data/repo'
import { requestSync } from '../../data/sync'
import { hasTrap } from '../../domain/plan'
import { isDue, MASTERED } from '../../domain/srs'
import type { Exercise, MistakeItem, TrapCategory } from '../../domain/types'
import { useI18n } from '../../i18n'
import { durationText } from '../../ui/format'
import { Badge, Button, ButtonLink, Card, PageHeader, Segmented } from '../../ui/kit'
import { VocabList } from '../vocab/VocabList'
import { WordSheet, type WordTarget } from '../vocab/WordSheet'
import { liveVocab } from '../../data/repo'
import { Replay } from '../results/ResultsPage'
import { HearDifference } from '../results/HearDifference'

/** Pick a review exercise: same confusion, preferably a different passage, least recently used. */
function pickReview(due: MistakeItem[], exercises: Exercise[], lastDone: Map<string, number>): Exercise | undefined {
  const lru = (l: Exercise[]) => [...l].sort((a, b) => (lastDone.get(a.id) ?? 0) - (lastDone.get(b.id) ?? 0))[0]
  const misses = due.filter((m) => m.type === 'miss' && m.trapCategory)
  for (const m of misses) {
    const cat = m.trapCategory as TrapCategory
    const fresh = exercises.filter((e) => hasTrap(e, cat) && e.id !== m.exerciseId)
    const any = fresh.length ? fresh : exercises.filter((e) => hasTrap(e, cat))
    if (any.length) return lru(any)
  }
  if (due.some((m) => m.type === 'false-positive')) return lru(exercises.filter((e) => e.kind === 'overclick'))
  return undefined
}

export function MistakesPage() {
  const { t } = useI18n()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'words' ? 'words' : 'mistakes'
  const mistakes = useLiveQuery(() => liveMistakes(), [], [])
  const vocab = useLiveQuery(() => liveVocab(), [], [])
  return (
    <div className="space-y-4">
      <PageHeader title={t('review.title')} />
      <Segmented
        value={tab}
        onChange={(v) => setParams(v === 'words' ? { tab: 'words' } : {}, { replace: true })}
        options={[
          { value: 'mistakes', label: `${t('review.tab.mistakes')} (${mistakes.length})` },
          { value: 'words', label: `${t('review.tab.words')} (${vocab.length})` },
        ]}
      />
      {tab === 'words' ? <VocabList /> : <MistakeBank />}
    </div>
  )
}

function MistakeBank() {
  const { exercises, exerciseById, settings } = useAppState()
  const { t, tk, lang } = useI18n()
  const [wordTarget, setWordTarget] = useState<WordTarget | null>(null)
  const mistakes = useLiveQuery(() => liveMistakes(), [], [])
  const attempts = useLiveQuery(() => recentAttempts(100), [], [])
  const now = Date.now()

  const lastDone = useMemo(() => {
    const m = new Map<string, number>()
    for (const a of attempts) if (!m.has(a.exerciseId)) m.set(a.exerciseId, a.completedAt)
    return m
  }, [attempts])

  const due = mistakes.filter((m) => isDue(m, now))
  const review = pickReview(due, exercises, lastDone)

  const groups = useMemo(() => {
    const g = new Map<string, MistakeItem[]>()
    for (const m of [...mistakes].sort((a, b) => a.dueAt - b.dueAt)) {
      const k = m.type === 'false-positive' || m.type === 'spelling' ? m.type : (m.trapCategory ?? 'other')
      g.set(k, [...(g.get(k) ?? []), m])
    }
    return [...g.entries()]
  }, [mistakes])

  /** Library examples of the same confusion type, so review isn't just the same sentence. */
  const similar = (cat: string) =>
    exercises
      .flatMap((e) => e.tokens.filter((x) => x.isIncorrect && x.trapCategory === cat).map((x) => `${x.displayText} → ${x.spokenText}`))
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 8)

  return (
    <div className="space-y-4">
      {mistakes.length > 0 && (
        <Card>
          <p className="text-sm text-ink-2">{t('mistakes.howItWorks', { n: mistakes.length, due: due.length })}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <ButtonLink variant="primary" to="/review/quick">
              {t('mistakes.quickReview')} →
            </ButtonLink>
            {review && (
              <ButtonLink to={`/play/${review.id}?mode=review&speed=${settings.speed}`}>
                {t('mistakes.startReview')}
              </ButtonLink>
            )}
          </div>
          <p className="mt-2 text-xs text-ink-3">{t('mistakes.schedule')}</p>
        </Card>
      )}

      {mistakes.length === 0 && (
        <Card>
          <p className="text-sm text-ink-2">{t('mistakes.empty')}</p>
        </Card>
      )}

      {groups.map(([key, items]) => (
        <Card
          key={key}
          title={
            <span className="flex items-center gap-2">
              {key === 'false-positive' || key === 'spelling' ? tk(`mistakes.type.${key}`) : tk(`trap.${key}`)}
              <Badge>{items.length}</Badge>
            </span>
          }
        >
          <ul className="divide-y divide-line">
            {items.map((m) => {
              const ex = exerciseById.get(m.exerciseId)
              const mastered = m.step >= MASTERED
              return (
                <li key={m.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                  <div className="min-w-48 flex-1">
                    <div className="text-base">
                      {m.type === 'spelling' ? (
                        <>
                          <span className="text-ink-3">{t('lst.youTyped', { w: m.display })}</span>
                          <span className="mx-1.5 text-ink-3">→</span>
                          <span className="font-semibold text-ink">{m.spoken}</span>
                        </>
                      ) : m.type === 'miss' ? (
                        <>
                          <span className="text-ink-3 line-through decoration-1">{m.display}</span>
                          <span className="mx-1.5 text-ink-3">→</span>
                          <span className="font-semibold text-ink">{m.spoken}</span>
                        </>
                      ) : (
                        <span className="font-semibold text-ink">{m.display}</span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-ink-3">{m.context}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Badge tone={mastered ? 'good' : isDue(m, now) ? 'warn' : 'neutral'}>
                        {mastered ? t('mistakes.mastered') : isDue(m, now) ? t('mistakes.dueNow') : t('mistakes.dueIn', { t: durationText(m.dueAt - now, lang) })}
                      </Badge>
                      <span className="text-xs tracking-widest text-accent" aria-label={`${m.step}/${MASTERED}`}>
                        {'●'.repeat(Math.min(m.step, MASTERED))}
                        <span className="text-ink-3">{'○'.repeat(Math.max(0, MASTERED - m.step))}</span>
                      </span>
                      {m.lapses > 0 && <span className="text-xs text-ink-3">{t('mistakes.lapses', { n: m.lapses })}</span>}
                    </div>
                  </div>
                  {m.type === 'miss' ? (
                    <div className="w-full">
                      <HearDifference
                        shown={m.display}
                        said={m.spoken}
                        ex={ex}
                        index={m.tokenIndex}
                        context={m.context.replace(/[[\]]/g, '')}
                        onLookUp={setWordTarget}
                      />
                    </div>
                  ) : (
                    <>
                      {ex && <Replay ex={ex} index={m.tokenIndex} />}
                      <Button
                        className="px-2.5 py-1 text-xs"
                        onClick={() => setWordTarget({ word: m.spoken, context: m.context.replace(/[[\]]/g, ''), exerciseId: m.exerciseId, tokenIndex: m.tokenIndex })}
                      >
                        {t('hear.lookUp')}
                      </Button>
                    </>
                  )}
                  <Button variant="ghost" className="px-2 text-xs" onClick={() => void deleteMistake(m.id).then(requestSync)} aria-label={t('common.delete')}>
                    ✕
                  </Button>
                </li>
              )
            })}
          </ul>
          {key !== 'false-positive' && key !== 'spelling' && key !== 'other' && similar(key).length > 1 && (
            <div className="mt-3 border-t border-line pt-3">
              <div className="mb-1.5 text-xs font-medium text-ink-3">{t('mistakes.similar')}</div>
              <div className="flex flex-wrap gap-1.5">
                {similar(key).map((s) => (
                  <Badge key={s}>{s}</Badge>
                ))}
              </div>
              <div className="mt-3">
                <ButtonLink className="px-3 py-1.5 text-xs" to={`/practice?mode=drill&cat=${key}`}>
                  {tk('mode.drill')} →
                </ButtonLink>
              </div>
            </div>
          )}
        </Card>
      ))}
      {wordTarget && <WordSheet target={wordTarget} onClose={() => setWordTarget(null)} />}
    </div>
  )
}
