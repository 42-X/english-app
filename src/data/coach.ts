import type { Attempt, ListeningAttempt, MistakeItem, VocabEntry } from '../domain/types'
import { supabase } from './sync'

// Coaching is online-only: links, notes and a learner's data are read straight from Supabase,
// never stored in this device's local database.

export interface CoachLink {
  learner_id: string
  learner_email: string
  learner_name: string | null
  coach_email: string
  created_at: string
}

export interface CoachNote {
  id: string
  learner_id: string
  coach_email: string
  body: string
  created_at: string
  read_at: string | null
}

async function me(): Promise<{ id: string; email: string } | null> {
  if (!supabase) return null
  const { data } = await supabase.auth.getUser()
  return data.user ? { id: data.user.id, email: (data.user.email ?? '').toLowerCase() } : null
}

function client() {
  if (!supabase) throw new Error('Sync is not configured')
  return supabase
}

// ── Learner side ──────────────────────────────────────────────────────

/** Coaches this learner shares progress with. */
export async function myCoaches(): Promise<CoachLink[]> {
  const user = await me()
  if (!user) return []
  const { data, error } = await client().from('coach_links').select('*').eq('learner_id', user.id).order('created_at')
  if (error) throw error
  return data as CoachLink[]
}

export async function addCoach(email: string, learnerName: string): Promise<void> {
  const { error } = await client()
    .from('coach_links')
    .insert({ coach_email: email.trim().toLowerCase(), learner_name: learnerName.trim() || null })
  if (error) throw error
}

export async function removeCoach(email: string): Promise<void> {
  const user = await me()
  if (!user) return
  const { error } = await client().from('coach_links').delete().eq('learner_id', user.id).eq('coach_email', email)
  if (error) throw error
}

/** Notes from coaches she hasn't dismissed yet, newest first. */
export async function unreadNotes(): Promise<CoachNote[]> {
  const user = await me()
  if (!user) return []
  const { data, error } = await client().from('coach_notes').select('*').eq('learner_id', user.id).is('read_at', null).order('created_at', { ascending: false })
  if (error) throw error
  return data as CoachNote[]
}

export async function markNoteRead(id: string): Promise<void> {
  const { error } = await client().from('coach_notes').update({ read_at: new Date().toISOString() }).eq('id', id)
  if (error) throw error
}

// ── Coach side ────────────────────────────────────────────────────────

/** Learners who share their progress with the signed-in account. */
export async function myLearners(): Promise<CoachLink[]> {
  const user = await me()
  if (!user) return []
  const { data, error } = await client().from('coach_links').select('*').eq('coach_email', user.email).order('created_at')
  if (error) throw error
  return data as CoachLink[]
}

export interface LearnerData {
  attempts: Attempt[]
  listening: ListeningAttempt[]
  mistakes: MistakeItem[]
  vocab: VocabEntry[]
}

/** A learner's recent practice (most recent first), read through the coach policies. */
export async function learnerData(learnerId: string): Promise<LearnerData> {
  const rows = async <T,>(table: string, limit: number): Promise<T[]> => {
    const { data, error } = await client()
      .from(table)
      .select('id,data,updated_at')
      .eq('user_id', learnerId)
      .eq('deleted', false)
      .order('updated_at', { ascending: false })
      .limit(limit)
    if (error) throw error
    return (data ?? []).map((r) => ({ ...(r.data as object), id: r.id, updatedAt: r.updated_at }) as T)
  }
  const byCompleted = <T extends { completedAt: number }>(xs: T[]) => xs.sort((a, b) => b.completedAt - a.completedAt)
  const [attempts, listening, mistakes, vocab] = await Promise.all([
    rows<Attempt>('attempts', 400),
    rows<ListeningAttempt>('listening_attempts', 300),
    rows<MistakeItem>('mistakes', 1000),
    rows<VocabEntry>('vocab', 500),
  ])
  return { attempts: byCompleted(attempts), listening: byCompleted(listening), mistakes, vocab }
}

export async function notesFor(learnerId: string): Promise<CoachNote[]> {
  const { data, error } = await client().from('coach_notes').select('*').eq('learner_id', learnerId).order('created_at', { ascending: false }).limit(30)
  if (error) throw error
  return data as CoachNote[]
}

export async function sendNote(learnerId: string, body: string): Promise<void> {
  const { error } = await client().from('coach_notes').insert({ learner_id: learnerId, body: body.trim() })
  if (error) throw error
}

export async function deleteNote(id: string): Promise<void> {
  const { error } = await client().from('coach_notes').delete().eq('id', id)
  if (error) throw error
}
