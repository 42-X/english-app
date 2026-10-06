import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'
import type { Table } from 'dexie'
import { db, getMeta, setMeta, SYNCED_TABLES, type SyncedTable } from './db'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const syncConfigured = Boolean(url && anonKey)
export const supabase: SupabaseClient | null = syncConfigured ? createClient(url!, anonKey!) : null

const REMOTE: Record<SyncedTable, string> = {
  attempts: 'attempts',
  mistakes: 'mistakes',
  plans: 'plans',
  customExercises: 'custom_exercises',
  settings: 'settings',
  vocab: 'vocab',
}

type Row = { id: string; updatedAt: number; dirty: 0 | 1; deleted?: 1 }
type RemoteRow = { id: string; data: Record<string, unknown>; updated_at: number; deleted: boolean; server_updated_at: string }

function table(name: SyncedTable): Table<Row, string> {
  return db[name] as unknown as Table<Row, string>
}

export type SyncStatus = { state: 'idle' | 'syncing' | 'error' | 'offline' | 'signed-out'; at?: number; error?: string }

let status: SyncStatus = { state: 'signed-out' }
const listeners = new Set<(s: SyncStatus) => void>()
function setStatus(s: SyncStatus) {
  status = s
  listeners.forEach((l) => l(s))
}
export function getSyncStatus(): SyncStatus {
  return status
}
export function onSyncStatus(l: (s: SyncStatus) => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Pull remote changes (newer wins), then push local dirty rows. */
async function syncTable(client: SupabaseClient, userId: string, name: SyncedTable): Promise<void> {
  const remote = REMOTE[name]
  const cursorKey = `pull:${userId}:${name}`
  const cursor = (await getMeta<string>(cursorKey)) ?? '1970-01-01T00:00:00Z'
  // Re-read a minute of overlap so commits racing the cursor are never skipped; merging is idempotent.
  const since = new Date(new Date(cursor).getTime() - 60_000).toISOString()

  let maxSeen = cursor
  for (let page = 0; ; page++) {
    const { data, error } = await client
      .from(remote)
      .select('id,data,updated_at,deleted,server_updated_at')
      .gt('server_updated_at', since)
      .order('server_updated_at')
      .range(page * 500, page * 500 + 499)
    if (error) throw error
    const rows = (data ?? []) as RemoteRow[]
    for (const r of rows) {
      const local = await table(name).get(r.id)
      if (!local || r.updated_at > (local.updatedAt ?? 0)) {
        await table(name).put({ ...(r.data as object), id: r.id, updatedAt: r.updated_at, dirty: 0, deleted: r.deleted ? 1 : undefined } as Row)
      }
      if (r.server_updated_at > maxSeen) maxSeen = r.server_updated_at
    }
    if (rows.length < 500) break
  }
  await setMeta(cursorKey, maxSeen)

  const dirty = await table(name).where('dirty').equals(1).toArray()
  for (let i = 0; i < dirty.length; i += 200) {
    const batch = dirty.slice(i, i + 200)
    const payload = batch.map((row) => {
      const { dirty: _d, deleted, ...data } = row
      return { user_id: userId, id: row.id, data, updated_at: row.updatedAt ?? 0, deleted: deleted === 1 }
    })
    const { error } = await client.from(remote).upsert(payload, { onConflict: 'user_id,id' })
    if (error) throw error
    for (const row of batch) {
      const cur = await table(name).get(row.id)
      if (cur && cur.updatedAt === row.updatedAt) await table(name).update(row.id, { dirty: 0 })
    }
  }
}

let running: Promise<void> | null = null

export async function syncNow(): Promise<void> {
  if (!supabase) return
  if (running) return running
  running = (async () => {
    const { data } = await supabase.auth.getSession()
    const session = data.session
    if (!session) return setStatus({ state: 'signed-out' })
    if (!navigator.onLine) return setStatus({ state: 'offline' })
    setStatus({ state: 'syncing' })
    try {
      await adoptLocalData(session)
      for (const name of SYNCED_TABLES) await syncTable(supabase, session.user.id, name)
      setStatus({ state: 'idle', at: Date.now() })
    } catch (e) {
      setStatus({ state: 'error', error: e instanceof Error ? e.message : String(e) })
    }
  })().finally(() => {
    running = null
  })
  return running
}

/**
 * The first time an account syncs on this device, everything practised anonymously
 * is marked for upload so no history is lost at sign-up.
 */
async function adoptLocalData(session: Session): Promise<void> {
  const key = `adopted:${session.user.id}`
  if (await getMeta<boolean>(key)) return
  for (const name of SYNCED_TABLES) await table(name).toCollection().modify({ dirty: 1 })
  await setMeta(key, true)
}

let timer: ReturnType<typeof setInterval> | null = null
let debounce: ReturnType<typeof setTimeout> | null = null

/** Request a sync soon (debounced) — call after local writes. */
export function requestSync(): void {
  if (!supabase) return
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => void syncNow(), 1500)
}

export function startAutoSync(): () => void {
  if (!supabase) return () => {}
  void syncNow()
  const { data: sub } = supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_IN') void syncNow()
    if (event === 'SIGNED_OUT') setStatus({ state: 'signed-out' })
  })
  const online = () => void syncNow()
  const visible = () => document.visibilityState === 'visible' && void syncNow()
  window.addEventListener('online', online)
  document.addEventListener('visibilitychange', visible)
  timer = setInterval(() => void syncNow(), 5 * 60_000)
  return () => {
    sub.subscription.unsubscribe()
    window.removeEventListener('online', online)
    document.removeEventListener('visibilitychange', visible)
    if (timer) clearInterval(timer)
  }
}
