import type { VocabEntry } from './types'

export type Meaning = VocabEntry['meanings'][number]

export interface DictionaryResult {
  word: string
  phonetic?: string
  audioUrl?: string
  meanings: Meaning[]
}

/** Lower-case, strip punctuation, keep internal hyphens/apostrophes. */
export function headword(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
}

interface ApiEntry {
  word?: string
  phonetic?: string
  phonetics?: { text?: string; audio?: string }[]
  meanings?: { partOfSpeech?: string; definitions?: { definition?: string; example?: string }[] }[]
}

/**
 * Parse a dictionaryapi.dev response: the first phonetic and audio found, and up to
 * two definitions for each of up to three parts of speech.
 */
export function parseDictionary(json: unknown): DictionaryResult | null {
  if (!Array.isArray(json) || json.length === 0) return null
  const entries = json as ApiEntry[]
  const phonetic = entries.flatMap((e) => [e.phonetic, ...(e.phonetics ?? []).map((p) => p.text)]).find((p): p is string => !!p)
  const audioUrl = entries.flatMap((e) => (e.phonetics ?? []).map((p) => p.audio)).find((a): a is string => !!a)
  const meanings: Meaning[] = []
  const seenPos = new Map<string, number>()
  for (const e of entries) {
    for (const m of e.meanings ?? []) {
      const pos = m.partOfSpeech ?? ''
      for (const d of m.definitions ?? []) {
        if (!d.definition) continue
        const n = seenPos.get(pos) ?? 0
        if (n >= 2 || (!seenPos.has(pos) && seenPos.size >= 3)) continue
        seenPos.set(pos, n + 1)
        meanings.push({ partOfSpeech: pos, definition: d.definition, example: d.example })
      }
    }
  }
  if (meanings.length === 0) return null
  return { word: entries[0].word ?? '', phonetic, audioUrl, meanings }
}

/** Milestones for the "words learned" counter. */
export const MILESTONES = [5, 10, 25, 50, 100, 200, 300, 500] as const

export function nextMilestone(known: number): number | null {
  return MILESTONES.find((m) => m > known) ?? null
}

interface WiktionaryDef {
  definition?: string
  examples?: string[]
}

const stripHtml = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

/** Parse Wiktionary's REST definition response (English section only). */
export function parseWiktionary(word: string, json: unknown): DictionaryResult | null {
  const en = (json as { en?: { partOfSpeech?: string; definitions?: WiktionaryDef[] }[] } | null)?.en
  if (!Array.isArray(en)) return null
  const meanings: Meaning[] = []
  const seen = new Map<string, number>()
  for (const sec of en) {
    const pos = (sec.partOfSpeech ?? '').toLowerCase()
    for (const d of sec.definitions ?? []) {
      const def = d.definition ? stripHtml(d.definition) : ''
      if (!def) continue
      const n = seen.get(pos) ?? 0
      if (n >= 2 || (!seen.has(pos) && seen.size >= 3)) continue
      seen.set(pos, n + 1)
      const ex = d.examples?.[0] ? stripHtml(d.examples[0]) : undefined
      meanings.push({ partOfSpeech: pos, definition: def, example: ex })
    }
  }
  return meanings.length ? { word, meanings } : null
}
