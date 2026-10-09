import { groupStats, isHiwAttempt, targetLevel, trapStats, weaknesses, type GroupStats, type TrapStat } from './adaptive'
import { mindChanges } from './analysis'
import { listeningStats, type ListeningStats } from './listening'
import { activeDays, sessions, wins, type Wins } from './momentum'
import { localDate } from './plan'
import { MASTERED, isDue } from './srs'
import type { Attempt, Exercise, Focus, ListeningAttempt, MistakeItem } from './types'

// A coach's overview of one learner: effort, accuracy by day, current weaknesses and her most
// recent results. Pure, so the coach page and the copy-paste summary agree.

const DAY = 86_400_000

export interface DayRow {
  date: string
  minutes: number
  /** Scored HIW questions. */
  hiw: number
  /** Share of changed words caught that day. */
  catchRate: number | null
  /** Extra (false) clicks per scored passage. */
  extraPer: number | null
  fibl: number | null
  wfd: number | null
}

export interface RecentResult {
  at: number
  title: string
  task: 'HIW' | 'FIB-L' | 'WFD' | 'Words'
  mode: string
  /** HIW: changed words caught / total. FIB-L, WFD: words right / total. */
  score: string
  /** HIW only. */
  extraClicks?: number
  unclickedRight?: number
}

export interface CoachSummary {
  lastActive: number | null
  daysActive14: number
  week: Wins
  lifetime: Wins
  days: DayRow[]
  focus: Focus[]
  level: 1 | 2 | 3
  /** Last 25 scored HIW questions vs the 25 before. */
  hiw: GroupStats
  hiwBefore: GroupStats
  traps: TrapStat[]
  listening: ListeningStats
  mistakes: { total: number; due: number; mastered: number }
  /** Over the last 25 HIW questions: unclicks that saved / lost a point. */
  mind: { saved: number; lost: number }
  recent: RecentResult[]
}

export function coachSummary(input: {
  attempts: readonly Attempt[]
  listening: readonly ListeningAttempt[]
  mistakes: readonly MistakeItem[]
  exById: ReadonlyMap<string, Exercise>
  now: number
}): CoachSummary {
  const { attempts, listening, mistakes, exById, now } = input
  const s = sessions(attempts, listening)
  const days = activeDays(s.filter((x) => x.at >= now - 14 * DAY))
  const hiw = attempts.filter(isHiwAttempt)

  const rows: DayRow[] = []
  for (let k = 0; k < 14; k++) {
    const d = new Date(now)
    d.setDate(d.getDate() - k)
    const date = localDate(d.getTime())
    const inDay = <T extends { completedAt: number }>(x: T) => localDate(x.completedAt) === date
    const a = attempts.filter(inDay)
    const l = listening.filter(inDay)
    if (!a.length && !l.length) continue
    const g = groupStats(a.filter(isHiwAttempt))
    const acc = (task: ListeningAttempt['task']) => {
      const xs = l.filter((x) => x.task === task)
      const total = xs.reduce((n, x) => n + x.total, 0)
      return total ? xs.reduce((n, x) => n + x.correct, 0) / total : null
    }
    rows.push({
      date,
      minutes: wins(a, l).minutes,
      hiw: g.n,
      catchRate: g.recall,
      extraPer: g.n ? g.falsePositives / g.n : null,
      fibl: acc('fibl'),
      wfd: acc('wfd'),
    })
  }

  let saved = 0
  let lost = 0
  for (const a of hiw.slice(0, 25)) {
    const ex = exById.get(a.exerciseId)
    if (!ex) continue
    const m = mindChanges(ex, a.interactions)
    saved += m.saved.length
    lost += m.lost.length
  }

  const recent: RecentResult[] = [
    ...attempts.slice(0, 20).map((a): RecentResult => {
      const ex = exById.get(a.exerciseId)
      const sc = a.summary.score
      const m = ex ? mindChanges(ex, a.interactions) : null
      return {
        at: a.completedAt,
        title: ex?.title ?? a.exerciseId,
        task: 'HIW',
        mode: a.mode,
        score: a.mode === 'guided' ? '—' : `${sc.hits}/${sc.mismatches}`,
        extraClicks: a.mode === 'guided' ? undefined : sc.falsePositives,
        unclickedRight: m?.lost.length,
      }
    }),
    ...listening.slice(0, 10).map(
      (a): RecentResult => ({
        at: a.completedAt,
        title: a.task === 'fibl' ? (exById.get(a.exerciseId)?.title ?? a.exerciseId) : a.task === 'words' ? `${a.items.length} questions` : `${a.items.length} sentences`,
        task: a.task === 'fibl' ? 'FIB-L' : a.task === 'words' ? 'Words' : 'WFD',
        mode: a.mode,
        score: `${a.correct}/${a.total}`,
      }),
    ),
  ]
    .sort((x, y) => y.at - x.at)
    .slice(0, 20)

  const weekStart = now - 7 * DAY
  return {
    lastActive: s.length ? Math.max(...s.map((x) => x.at)) : null,
    daysActive14: days.size,
    week: wins(attempts, listening, weekStart),
    lifetime: wins(attempts, listening),
    days: rows,
    focus: weaknesses(attempts),
    level: targetLevel(attempts),
    hiw: groupStats(hiw.slice(0, 25)),
    hiwBefore: groupStats(hiw.slice(25, 50)),
    traps: trapStats(hiw.slice(0, 50)).filter((t) => t.total >= 2).slice(0, 6),
    listening: listeningStats(listening.slice(0, 20)),
    mistakes: {
      total: mistakes.length,
      due: mistakes.filter((m) => isDue(m, now)).length,
      mastered: mistakes.filter((m) => m.step >= MASTERED).length,
    },
    mind: { saved, lost },
    recent,
  }
}

const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`)

/** Plain-text summary for pasting into a chat with Claude (or anyone) to get coaching suggestions. */
export function coachMarkdown(name: string, s: CoachSummary, now: number): string {
  const L: string[] = []
  L.push(`# PTE listening practice — ${name}`, '', `Generated ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC.`, '')
  L.push('## Effort')
  L.push(`- Active ${s.daysActive14} of the last 14 days; last practice ${s.lastActive ? new Date(s.lastActive).toISOString().slice(0, 10) : 'never'}`)
  L.push(`- Last 7 days: ${s.week.done} questions/sets, ${s.week.minutes} min, ${s.week.caught} HIW words caught, ${s.week.written} FIB-L/WFD words written correctly, ${s.week.words} word-game answers right`)
  L.push(`- All time: ${s.lifetime.done} questions/sets, ${s.lifetime.minutes} min`)
  L.push('', '## Highlight Incorrect Words (last 25 scored vs previous 25)')
  L.push(`- Catch rate (changed words found): ${pct(s.hiw.recall)} (before ${pct(s.hiwBefore.recall)})`)
  L.push(`- Click accuracy (clicks that were real changes): ${pct(s.hiw.precision)} (before ${pct(s.hiwBefore.precision)})`)
  L.push(`- Extra clicks per passage: ${s.hiw.n ? (s.hiw.falsePositives / s.hiw.n).toFixed(1) : '—'}`)
  L.push(`- Pointer within ±2 words of the audio: ${pct(s.hiw.within2)}; share of misses while behind: ${pct(s.hiw.missesDuringLossShare)}`)
  L.push(`- Unclicks: ${s.mind.saved} saved a point, ${s.mind.lost} undid a correct click`)
  L.push(`- Difficulty level: ${['easier', 'exam standard', 'advanced'][s.level - 1]}`)
  if (s.traps.length) L.push(`- Most-missed types: ${s.traps.map((t) => `${t.category} ${t.misses}/${t.total}`).join(', ')}`)
  L.push(`- App's current focus: ${s.focus.map((f) => (f.type === 'trap' ? `trap ${f.category}` : f.type)).join(', ') || 'none'}`)
  L.push('', '## Fill in the Blanks & Write From Dictation (last 20 sets)')
  L.push(`- FIB-L accuracy ${pct(s.listening.fibl.accuracy)} over ${s.listening.fibl.attempts} passages; WFD accuracy ${pct(s.listening.wfd.accuracy)} over ${s.listening.wfd.attempts} sets`)
  const k = s.listening.kinds
  L.push(`- Errors: wrong ending ${k.ending}, misspelled ${k.spelling}, different word ${k.wrong}, left blank ${k.blank}`)
  if (s.listening.topWords.length) L.push(`- Most-missed words: ${s.listening.topWords.map((w) => `${w.word} (${w.count})`).join(', ')}`)
  L.push('', `## Review bank: ${s.mistakes.total} words, ${s.mistakes.due} due, ${s.mistakes.mastered} mastered`)
  L.push('', '## By day', '', '| Date | Min | HIW Qs | Catch | Extra clicks/Q | FIB-L | WFD |', '|---|---|---|---|---|---|---|')
  for (const d of s.days) {
    L.push(`| ${d.date} | ${d.minutes} | ${d.hiw} | ${pct(d.catchRate)} | ${d.extraPer === null ? '—' : d.extraPer.toFixed(1)} | ${pct(d.fibl)} | ${pct(d.wfd)} |`)
  }
  L.push('', '## Recent results', '', '| When | Task | Mode | Passage | Score | Extra clicks | Unclicked a right answer |', '|---|---|---|---|---|---|---|')
  for (const r of s.recent) {
    L.push(`| ${new Date(r.at).toISOString().slice(0, 16).replace('T', ' ')} | ${r.task} | ${r.mode} | ${r.title} | ${r.score} | ${r.extraClicks ?? ''} | ${r.unclickedRight || ''} |`)
  }
  return L.join('\n')
}
