import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAppState } from '../../app/state'
import { deleteNote, learnerData, myLearners, notesFor, sendNote, type CoachLink, type CoachNote, type LearnerData } from '../../data/coach'
import { supabase } from '../../data/sync'
import { coachMarkdown, coachSummary, type CoachSummary } from '../../domain/coach'
import { focusCoaching } from '../../domain/coaching'
import { useCoachText, useI18n } from '../../i18n'
import { pct } from '../../ui/format'
import { Badge, Button, Card, CoachLine, PageHeader, Segmented, Stat } from '../../ui/kit'

// The coach view is for the coach (not the learner), so its text is English only.

export function CoachPage() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [learners, setLearners] = useState<CoachLink[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)

  useEffect(() => {
    if (!supabase) return setSignedIn(false)
    void supabase.auth.getUser().then(({ data }) => {
      setSignedIn(!!data.user)
      if (data.user)
        myLearners()
          .then((l) => {
            setLearners(l)
            setChosen((c) => c ?? l[0]?.learner_id ?? null)
          })
          .catch((e: Error) => setError(e.message))
    })
  }, [])

  const header = <PageHeader title="Coach view" sub="Read-only view of the progress your learners share with you." />
  if (signedIn === null || (signedIn && learners === null && !error)) return <div>{header}<p className="text-ink-2">Loading…</p></div>
  if (!signedIn)
    return (
      <div className="space-y-4">
        {header}
        <Card>
          <p className="text-sm text-ink-2">
            Sign in under <Link className="text-accent underline" to="/settings">Settings → Account</Link> with your own email (create an account if you don’t have
            one). Then ask your learner to add that email under Settings → Share my progress.
          </p>
        </Card>
      </div>
    )
  if (error) return <div className="space-y-4">{header}<p className="text-bad">{error}</p></div>
  if (!learners?.length)
    return (
      <div className="space-y-4">
        {header}
        <Card>
          <p className="text-sm text-ink-2">
            Nobody shares their progress with this account yet. Ask your learner to open Settings → Share my progress and add the email you signed in with.
          </p>
        </Card>
      </div>
    )

  const link = learners.find((l) => l.learner_id === chosen) ?? learners[0]
  return (
    <div className="space-y-4">
      {header}
      {learners.length > 1 && (
        <Segmented value={link.learner_id} onChange={setChosen} options={learners.map((l) => ({ value: l.learner_id, label: l.learner_name || l.learner_email }))} />
      )}
      <LearnerView key={link.learner_id} link={link} />
    </div>
  )
}

function LearnerView({ link }: { link: CoachLink }) {
  const { exerciseById, ready } = useAppState()
  const [data, setData] = useState<LearnerData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now] = useState(() => Date.now())

  useEffect(() => {
    learnerData(link.learner_id)
      .then(setData)
      .catch((e: Error) => setError(e.message))
  }, [link.learner_id])

  if (error) return <p className="text-bad">{error}</p>
  if (!data || !ready) return <p className="text-ink-2">Loading her practice…</p>
  const s = coachSummary({ ...data, exById: exerciseById, now })
  const name = link.learner_name || link.learner_email
  return (
    <div className="space-y-4">
      <Overview name={name} s={s} now={now} />
      <Notes learnerId={link.learner_id} name={name} />
      <Skills s={s} />
      <ByDay s={s} />
      <Recent s={s} />
    </div>
  )
}

function Overview({ name, s, now }: { name: string; s: CoachSummary; now: number }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(coachMarkdown(name, s, now))
    setCopied(true)
    setTimeout(() => setCopied(false), 2500)
  }
  return (
    <Card
      title={name}
      action={
        <Button onClick={() => void copy()} title="Copy a text summary to paste into a chat with Claude for suggestions">
          {copied ? '✓ Copied' : '📋 Copy summary for Claude'}
        </Button>
      }
    >
      <p className="-mt-2 mb-3 text-sm text-ink-3">
        Last practice: {s.lastActive ? new Date(s.lastActive).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'never'}
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Days active (14 d)" value={s.daysActive14} />
        <Stat label="This week" value={`${s.week.minutes} min`} sub={`${s.week.done} questions`} />
        <Stat label="Points this week" value={s.week.caught + s.week.written + s.week.words} sub="HIW caught + typed right + word games" />
        <Stat label="Review bank" value={s.mistakes.total} sub={`${s.mistakes.due} due · ${s.mistakes.mastered} mastered`} />
      </div>
    </Card>
  )
}

function Skills({ s }: { s: CoachSummary }) {
  const { tk } = useI18n()
  const coach = useCoachText()
  const trend = (now: number | null, before: number | null, invert = false) => {
    if (now === null || before === null || !s.hiwBefore.n) return null
    const d = Math.round((invert ? before - now : now - before) * 100)
    return d === 0 ? 'same as before' : `${d > 0 ? '▲' : '▼'} ${Math.abs(d)} pts vs previous 25`
  }
  const extra = (g: CoachSummary['hiw']) => (g.n ? g.falsePositives / g.n : null)
  return (
    <Card title="Skills">
      <h3 className="mb-2 text-sm font-semibold text-ink">Highlight Incorrect Words · last {s.hiw.n} scored questions</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Catch rate" value={pct(s.hiw.recall)} sub={trend(s.hiw.recall, s.hiwBefore.recall) ?? 'changed words found'} />
        <Stat label="Click accuracy" value={pct(s.hiw.precision)} sub={trend(s.hiw.precision, s.hiwBefore.precision) ?? 'clicks that were right'} />
        <Stat label="Extra clicks / question" value={extra(s.hiw)?.toFixed(1) ?? '—'} sub={s.hiwBefore.n ? `before ${extra(s.hiwBefore)?.toFixed(1) ?? '—'}` : undefined} />
        <Stat label="Tracking (±2 words)" value={pct(s.hiw.within2)} sub={trend(s.hiw.within2, s.hiwBefore.within2) ?? undefined} />
      </div>
      <p className="mt-2 text-sm text-ink-2">
        Unclicks: {s.mind.saved} saved a point · {s.mind.lost} undid a correct click. Level: {tk(`home.level.${s.level}`)}.
      </p>
      {s.traps.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-xs font-medium text-ink-3">Most-missed types</div>
          <div className="flex flex-wrap gap-1.5">
            {s.traps.map((t) => (
              <Badge key={t.category} tone={t.missRate >= 0.5 ? 'warn' : 'neutral'}>
                {tk(`trap.${t.category}`)} · missed {t.misses}/{t.total}
              </Badge>
            ))}
          </div>
        </div>
      )}
      <div className="mt-3 space-y-1.5">
        <div className="text-xs font-medium text-ink-3">What the app is working on with her</div>
        {s.focus.map((f, i) => {
          const c = focusCoaching(f)
          return (
            <CoachLine key={i} tone="info">
              {coach(c.key, c.params)}
            </CoachLine>
          )
        })}
      </div>

      <h3 className="mt-5 mb-2 text-sm font-semibold text-ink">Fill in the Blanks & Dictation · last 20 sets</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Fill in the Blanks" value={pct(s.listening.fibl.accuracy)} sub={`${s.listening.fibl.attempts} passages`} />
        <Stat label="Write From Dictation" value={pct(s.listening.wfd.accuracy)} sub={`${s.listening.wfd.attempts} sets`} />
        <Stat label="Wrong endings" value={s.listening.kinds.ending} sub="-s / -ed / -ing" />
        <Stat label="Misspelled" value={s.listening.kinds.spelling} sub={`${s.listening.kinds.wrong} different word · ${s.listening.kinds.blank} blank`} />
      </div>
      {s.listening.topWords.length > 0 && (
        <p className="mt-2 text-sm text-ink-2">Most-missed words: {s.listening.topWords.map((w) => `${w.word} (${w.count})`).join(', ')}</p>
      )}
    </Card>
  )
}

function ByDay({ s }: { s: CoachSummary }) {
  if (!s.days.length) return null
  return (
    <Card title="Last 14 days">
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full text-sm tabular-nums">
          <thead className="text-left text-xs text-ink-3">
            <tr>
              {['Day', 'Min', 'HIW Qs', 'Catch', 'Extra/Q', 'FIB-L', 'WFD'].map((h) => (
                <th key={h} className="px-1 py-1 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {s.days.map((d) => (
              <tr key={d.date}>
                <td className="px-1 py-1.5 whitespace-nowrap text-ink">{new Date(`${d.date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</td>
                <td className="px-1 py-1.5">{d.minutes}</td>
                <td className="px-1 py-1.5">{d.hiw}</td>
                <td className="px-1 py-1.5">{pct(d.catchRate)}</td>
                <td className="px-1 py-1.5">{d.extraPer === null ? '—' : d.extraPer.toFixed(1)}</td>
                <td className="px-1 py-1.5">{pct(d.fibl)}</td>
                <td className="px-1 py-1.5">{pct(d.wfd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function Recent({ s }: { s: CoachSummary }) {
  const { tk } = useI18n()
  return (
    <Card title="Recent results">
      <ul className="divide-y divide-line text-sm">
        {s.recent.map((r, i) => (
          <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-2">
            <span className="w-28 shrink-0 text-xs text-ink-3">{new Date(r.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            <Badge>{r.task}</Badge>
            <span className="min-w-0 flex-1 truncate text-ink">
              {r.title} <span className="text-ink-3">· {r.task === 'HIW' ? tk(`mode.${r.mode}`) : r.mode}</span>
            </span>
            <span className="text-ink-2 tabular-nums">
              {r.score}
              {r.extraClicks ? ` · ${r.extraClicks} extra` : ''}
              {r.unclickedRight ? ` · ↩ ${r.unclickedRight}` : ''}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-ink-3">HIW score = changed words caught / total. “extra” = clicks on words that were correct. ↩ = unclicked a word that really was different.</p>
    </Card>
  )
}

function Notes({ learnerId, name }: { learnerId: string; name: string }) {
  const [notes, setNotes] = useState<CoachNote[] | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = () => void notesFor(learnerId).then(setNotes, (e: Error) => setError(e.message))
  useEffect(load, [learnerId])

  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      await sendNote(learnerId, draft)
      setDraft('')
      load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title={`Send ${name} a note`}>
      <p className="-mt-2 mb-2 text-xs text-ink-3">It appears at the top of her Home screen until she taps “Thanks”. Encouragement plus one concrete tip works best.</p>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        maxLength={2000}
        rows={3}
        placeholder="e.g. Great week — 5 days of practice! This week, try to only click when you’re sure: your catch rate is already good."
        className="w-full rounded-lg border border-line bg-surface-2 p-3 text-sm text-ink"
      />
      <div className="mt-2 flex items-center gap-3">
        <Button variant="primary" disabled={busy || !draft.trim()} onClick={() => void send()}>
          Send note
        </Button>
        {error && <span className="text-sm text-bad">{error}</span>}
      </div>
      {notes && notes.length > 0 && (
        <ul className="mt-4 divide-y divide-line">
          {notes.map((n) => (
            <li key={n.id} className="flex items-start gap-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <p className="whitespace-pre-wrap text-ink">{n.body}</p>
                <p className="mt-0.5 text-xs text-ink-3">
                  {new Date(n.created_at).toLocaleString()} · {n.read_at ? `seen ${new Date(n.read_at).toLocaleDateString()}` : 'not seen yet'}
                </p>
              </div>
              <Button variant="ghost" className="px-2 text-xs" aria-label="Delete note" onClick={() => void deleteNote(n.id).then(load)}>
                ✕
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
