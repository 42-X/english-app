import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react'
import { DICTIONARIES, type Language, type StringKey } from './strings'

export type { StringKey } from './strings'

type Params = Record<string, string | number>
export type T = (key: StringKey, params?: Params) => string

interface I18n {
  lang: Language
  t: T
  /** For dynamic keys built at runtime (e.g. `trap.${cat}`); falls back to the key. */
  tk: (key: string, params?: Params) => string
}

const Ctx = createContext<I18n | null>(null)

function format(template: string, params?: Params): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (k in params ? String(params[k]) : `{${k}}`))
}

export function I18nProvider({ lang, children }: { lang: Language; children: ReactNode }) {
  const dict = DICTIONARIES[lang]
  const t = useCallback<T>((key, params) => format(dict[key] ?? key, params), [dict])
  const tk = useCallback((key: string, params?: Params) => format((dict as Record<string, string>)[key] ?? key, params), [dict])
  const value = useMemo(() => ({ lang, t, tk }), [lang, t, tk])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useI18n(): I18n {
  const v = useContext(Ctx)
  if (!v) throw new Error('useI18n outside I18nProvider')
  return v
}

/** Render a coaching line, translating trap-category lists in params. */
export function useCoachText() {
  const { tk } = useI18n()
  return (key: string, params?: Params) => {
    const p = { ...params }
    if (typeof p.cat === 'string') p.cat = tk(`trap.${p.cat}`)
    if (typeof p.cats === 'string') {
      p.cats = p.cats
        .split(',')
        .filter(Boolean)
        .map((c) => tk(`trap.${c}`))
        .join('、')
    }
    return tk(key, p)
  }
}
