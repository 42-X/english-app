import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LOCAL_AUDIO_PREFIX } from '../../audio/engine'
import { db, newId } from '../../data/db'
import { requestSync } from '../../data/sync'
import { buildTokens, diffTranscripts } from '../../domain/text'
import { estimateTimings } from '../../domain/timing'
import { TRAP_CATEGORIES, type Accent, type Exercise, type TrapCategory } from '../../domain/types'
import { useI18n } from '../../i18n'
import { Badge, Button, ButtonLink, Card, PageHeader, Segmented } from '../../ui/kit'

const WORD_MS = 385

interface Form {
  id?: string
  title: string
  topic: string
  accent: Accent
  difficulty: 1 | 2 | 3
  display: string
  spoken: string
}

const EMPTY: Form = { title: '', topic: '', accent: 'US', difficulty: 2, display: '', spoken: '' }

function audioDuration(file: Blob): Promise<number> {
  return new Promise((resolve, reject) => {
    const el = new Audio(URL.createObjectURL(file))
    el.addEventListener('loadedmetadata', () => resolve(el.duration * 1000), { once: true })
    el.addEventListener('error', () => reject(new Error('audio')), { once: true })
  })
}

export function CreatePage() {
  const { t, tk } = useI18n()
  const navigate = useNavigate()
  const [form, setForm] = useState<Form>(EMPTY)
  const [overrides, setOverrides] = useState<Record<number, TrapCategory>>({})
  const [audioMode, setAudioMode] = useState<'tts' | 'upload'>('tts')
  const [file, setFile] = useState<File | null>(null)
  const [stamps, setStamps] = useState('')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const mine = useLiveQuery(() => db.customExercises.filter((e) => !e.deleted).toArray(), [], [])

  const diff = useMemo(() => diffTranscripts(form.display, form.spoken || form.display), [form.display, form.spoken])
  const pairs = diff.pairs.map((p, i) => (p.isIncorrect && overrides[i] ? { ...p, trapCategory: overrides[i] } : p))
  const mismatches = pairs.map((p, i) => ({ ...p, i })).filter((p) => p.isIncorrect)
  const countProblem = diff.problems.find((p) => p.startsWith('word-count'))

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setSaved(false)
    setForm((f) => ({ ...f, [k]: v }))
  }

  const save = async () => {
    setError('')
    if (!form.title.trim() || !pairs.length || countProblem) return
    const id = form.id ?? `custom-${newId().slice(0, 8)}`
    const now = Date.now()
    let timings = estimateTimings(
      pairs.map((p) => p.spoken),
      pairs.length * WORD_MS,
    )
    let source: Exercise['source'] = 'browser-tts'
    let timing: Exercise['timing'] = 'approximate'
    let audioUrl: string | undefined
    let durationMs = pairs.length * WORD_MS

    if (audioMode === 'upload' && file) {
      try {
        durationMs = await audioDuration(file)
      } catch {
        return setError('audio')
      }
      await db.audio.put({ id, blob: file })
      audioUrl = `${LOCAL_AUDIO_PREFIX}${id}`
      source = 'recorded'
      timings = estimateTimings(
        pairs.map((p) => p.spoken),
        durationMs,
        250,
      )
      if (stamps.trim()) {
        try {
          const parsed = JSON.parse(stamps) as { startMs: number; endMs: number }[]
          if (!Array.isArray(parsed) || parsed.length !== pairs.length) throw new Error()
          timings = parsed.map((p) => ({ startMs: Number(p.startMs), endMs: Number(p.endMs) }))
          timing = 'exact'
        } catch {
          return setError('stamps')
        }
      }
    }

    const ex: Exercise = {
      id,
      title: form.title.trim(),
      topic: form.topic.trim() || 'custom',
      kind: 'realistic',
      difficulty: form.difficulty,
      source,
      audioUrl,
      durationMs,
      accent: form.accent,
      timing,
      tokens: buildTokens(pairs, timings),
      tags: ['custom'],
      custom: true,
      createdAt: now,
      updatedAt: now,
    }
    await db.customExercises.put({ ...ex, dirty: 1 })
    requestSync()
    setSaved(true)
    setForm((f) => ({ ...f, id }))
  }

  const edit = (e: Exercise) => {
    setForm({
      id: e.id,
      title: e.title,
      topic: e.topic,
      accent: e.accent,
      difficulty: e.difficulty,
      display: e.tokens.map((x) => `${x.leading}${x.displayText}${x.trailing}`).join(' '),
      spoken: e.tokens.map((x) => `${x.leading}${x.spokenText}${x.trailing}`).join(' '),
    })
    setOverrides({})
    setSaved(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const remove = async (e: Exercise) => {
    await db.customExercises.update(e.id, { deleted: 1, dirty: 1, updatedAt: Date.now() })
    await db.audio.delete(e.id)
    requestSync()
  }

  const input = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none'

  return (
    <div className="space-y-4">
      <PageHeader title={t('create.title')} sub={t('create.intro')} />
      <Card>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block text-ink-2">{t('create.fTitle')}</span>
            <input className={input} value={form.title} onChange={(e) => set('title', e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-ink-2">{t('create.fTopic')}</span>
            <input className={input} value={form.topic} onChange={(e) => set('topic', e.target.value)} />
          </label>
          <div className="text-sm">
            <span className="mb-1 block text-ink-2">{t('create.fAccent')}</span>
            <Segmented value={form.accent} onChange={(v) => set('accent', v)} options={(['US', 'UK', 'AU', 'IN', 'CA'] as Accent[]).map((a) => ({ value: a, label: a }))} />
          </div>
          <div className="text-sm">
            <span className="mb-1 block text-ink-2">{t('create.fDifficulty')}</span>
            <Segmented value={form.difficulty} onChange={(v) => set('difficulty', v)} options={[1, 2, 3].map((d) => ({ value: d as 1 | 2 | 3, label: '●'.repeat(d) }))} />
          </div>
        </div>

        <label className="mt-4 block text-sm">
          <span className="mb-1 block text-ink-2">{t('create.fDisplay')}</span>
          <textarea className={`${input} min-h-28`} value={form.display} onChange={(e) => set('display', e.target.value)} />
        </label>
        <label className="mt-3 block text-sm">
          <span className="mb-1 flex items-center justify-between text-ink-2">
            {t('create.fSpoken')}
            <button type="button" className="text-xs text-accent hover:underline" onClick={() => set('spoken', form.display)}>
              {t('create.copyDisplay')}
            </button>
          </span>
          <textarea className={`${input} min-h-28`} value={form.spoken} onChange={(e) => set('spoken', e.target.value)} />
        </label>

        <div className="mt-4">
          <div className="mb-2 text-sm font-medium text-ink">{t('create.detected')}</div>
          {countProblem ? (
            <p className="text-sm text-bad">{t('create.wordCount', { a: countProblem.split(':')[1], b: countProblem.split(':')[2] })}</p>
          ) : mismatches.length === 0 ? (
            <p className="text-sm text-ink-3">{t('create.noneDetected')}</p>
          ) : (
            <ul className="space-y-2">
              {mismatches.map((m) => (
                <li key={m.i} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-ink-3 line-through">{m.display.core}</span>→<span className="font-medium text-ink">{m.spoken}</span>
                  <select
                    className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink"
                    value={m.trapCategory}
                    onChange={(e) => setOverrides((o) => ({ ...o, [m.i]: e.target.value as TrapCategory }))}
                  >
                    {TRAP_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {tk(`trap.${c}`)}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-5">
          <div className="mb-2 text-sm font-medium text-ink">{t('create.audio')}</div>
          <Segmented
            value={audioMode}
            onChange={setAudioMode}
            options={[
              { value: 'tts', label: t('create.audioTts') },
              { value: 'upload', label: t('create.audioUpload') },
            ]}
          />
          {audioMode === 'upload' && (
            <div className="mt-3 space-y-3">
              <input type="file" accept="audio/*" className="block text-sm text-ink-2" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              <label className="block text-sm">
                <span className="mb-1 block text-ink-2">{t('create.timestamps')}</span>
                <textarea className={`${input} min-h-20 font-mono text-xs`} value={stamps} onChange={(e) => setStamps(e.target.value)} />
                <span className="mt-1 block text-xs text-ink-3">{t('create.timestampsHint')}</span>
              </label>
            </div>
          )}
          {audioMode === 'tts' && <p className="mt-2 text-xs text-warn">{t('common.approxNote')}</p>}
        </div>

        {error && <p className="mt-3 text-sm text-bad">{error === 'stamps' ? t('create.timestampsHint') : t('player.audioError')}</p>}

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={() => void save()} disabled={!form.title.trim() || !form.display.trim() || !!countProblem || (audioMode === 'upload' && !file && !form.id)}>
            {t('common.save')}
          </Button>
          {saved && form.id && (
            <>
              <Badge tone="good">{t('create.saved')}</Badge>
              <Button onClick={() => navigate(`/play/${form.id}?mode=practice`)}>{t('create.preview')} →</Button>
            </>
          )}
          {form.id && (
            <Button
              variant="ghost"
              onClick={() => {
                setForm(EMPTY)
                setSaved(false)
              }}
            >
              {t('common.cancel')}
            </Button>
          )}
        </div>
      </Card>

      <Card title={t('create.mine')}>
        {mine.length === 0 ? (
          <p className="text-sm text-ink-3">{t('create.empty')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {mine.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-2 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink">{e.title}</div>
                  <div className="text-xs text-ink-3">
                    {e.tokens.filter((x) => x.isIncorrect).length} · {e.accent} · {e.timing === 'exact' ? 'exact' : t('common.approx')}
                  </div>
                </div>
                <ButtonLink className="px-3 py-1.5 text-xs" to={`/play/${e.id}?mode=practice`}>
                  {t('common.start')}
                </ButtonLink>
                <Button className="px-3 py-1.5 text-xs" onClick={() => edit(e)}>
                  {t('common.edit')}
                </Button>
                <Button variant="danger" className="px-3 py-1.5 text-xs" onClick={() => void remove(e)}>
                  {t('common.delete')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
