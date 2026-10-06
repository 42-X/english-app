import { useLiveQuery } from 'dexie-react-hooks'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { prefetchAudio } from '../audio/engine'
import { db } from '../data/db'
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../data/repo'
import { requestSync } from '../data/sync'
import type { Exercise, Settings } from '../domain/types'

interface AppState {
  settings: Settings
  updateSettings: (patch: Partial<Settings>) => Promise<void>
  /** Built-in library + learner's custom exercises. */
  exercises: Exercise[]
  exerciseById: Map<string, Exercise>
  libraryError: boolean
  ready: boolean
}

const Ctx = createContext<AppState | null>(null)

export function AppStateProvider({ children }: { children: ReactNode }) {
  const settingsRow = useLiveQuery(() => loadSettings(), [], undefined)
  const settings = settingsRow ?? DEFAULT_SETTINGS
  const custom = useLiveQuery(() => db.customExercises.filter((e) => !e.deleted).toArray(), [], [])
  const [library, setLibrary] = useState<Exercise[] | null>(null)
  const [libraryError, setLibraryError] = useState(false)

  useEffect(() => {
    fetch('/content/library.json')
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status))
        return r.json() as Promise<Exercise[]>
      })
      .then((lib) => {
        setLibrary(lib)
        if (import.meta.env.PROD) prefetchAudio(lib.map((e) => e.audioUrl).filter((u): u is string => !!u))
      })
      .catch(() => setLibraryError(true))
  }, [])

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    await saveSettings(patch)
    requestSync()
  }, [])

  const value = useMemo<AppState>(() => {
    const exercises = [...(library ?? []), ...custom]
    return {
      settings,
      updateSettings,
      exercises,
      exerciseById: new Map(exercises.map((e) => [e.id, e])),
      libraryError,
      ready: library !== null && settingsRow !== undefined,
    }
  }, [library, custom, settings, settingsRow, updateSettings, libraryError])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAppState(): AppState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAppState outside AppStateProvider')
  return v
}
