import Dexie, { type EntityTable } from 'dexie'
import type { Attempt, DailyPlan, Exercise, ListeningAttempt, MistakeItem, Settings, VocabEntry } from '../domain/types'

/** Every synced record carries a dirty flag (1 = not yet pushed) and an optional tombstone. */
export interface SyncFields {
  dirty: 0 | 1
  deleted?: 1
}

export type AttemptRow = Attempt & SyncFields
export type MistakeRow = MistakeItem & SyncFields
export type PlanRow = DailyPlan & SyncFields
export type CustomExerciseRow = Exercise & SyncFields
export type SettingsRow = Settings & SyncFields & { id: 'settings' }
export type VocabRow = VocabEntry & SyncFields
export type ListeningRow = ListeningAttempt & SyncFields

export interface MetaRow {
  key: string
  value: unknown
}

export interface AudioBlobRow {
  id: string
  blob: Blob
}

export const db = new Dexie('hiw-trainer') as Dexie & {
  attempts: EntityTable<AttemptRow, 'id'>
  mistakes: EntityTable<MistakeRow, 'id'>
  plans: EntityTable<PlanRow, 'id'>
  customExercises: EntityTable<CustomExerciseRow, 'id'>
  settings: EntityTable<SettingsRow, 'id'>
  meta: EntityTable<MetaRow, 'key'>
  audio: EntityTable<AudioBlobRow, 'id'>
  vocab: EntityTable<VocabRow, 'id'>
  listening: EntityTable<ListeningRow, 'id'>
}

db.version(1).stores({
  attempts: 'id, exerciseId, completedAt, mode, dirty',
  mistakes: 'id, dueAt, step, dirty',
  plans: 'id, date, dirty',
  customExercises: 'id, dirty',
  settings: 'id, dirty',
  meta: 'key',
  audio: 'id',
})

// v2: "My words" vocabulary list.
db.version(2).stores({
  vocab: 'id, status, addedAt, dirty',
})

// v3: FIB-L and WFD results.
db.version(3).stores({
  listening: 'id, task, completedAt, dirty',
})

export const SYNCED_TABLES = ['attempts', 'mistakes', 'plans', 'customExercises', 'settings', 'vocab', 'listening'] as const
export type SyncedTable = (typeof SYNCED_TABLES)[number]

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await db.meta.get(key))?.value as T | undefined
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value })
}

export function newId(): string {
  return crypto.randomUUID()
}
