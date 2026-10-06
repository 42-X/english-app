import { useEffect } from 'react'
import { BrowserRouter, NavLink, Outlet, Route, Routes } from 'react-router-dom'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { startAutoSync } from '../data/sync'
import { CreatePage } from '../features/create/CreatePage'
import { HomePage } from '../features/home/HomePage'
import { MistakesPage } from '../features/mistakes/MistakesPage'
import { PlayerPage } from '../features/player/PlayerPage'
import { PracticePage } from '../features/practice/PracticePage'
import { ProgressPage } from '../features/progress/ProgressPage'
import { ResultsPage } from '../features/results/ResultsPage'
import { SettingsPage } from '../features/settings/SettingsPage'
import { I18nProvider, useI18n, type StringKey } from '../i18n'
import { AppStateProvider, useAppState } from './state'

export function App() {
  return (
    <AppStateProvider>
      <Localized />
    </AppStateProvider>
  )
}

function Localized() {
  const { settings, libraryError } = useAppState()

  useEffect(() => {
    const root = document.documentElement
    if (settings.theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', settings.theme)
    root.lang = settings.language
  }, [settings.theme, settings.language])

  useEffect(() => startAutoSync(), [])

  return (
    <I18nProvider lang={settings.language}>
      {libraryError && <div className="bg-bad-soft px-4 py-2 text-center text-sm text-bad">Could not load the exercise library. Check your connection and reload.</div>}
      <BrowserRouter>
        <Routes>
          <Route path="/play/:id" element={<PlayerPage />} />
          <Route element={<Shell />}>
            <Route index element={<HomePage />} />
            <Route path="/practice" element={<PracticePage />} />
            <Route path="/results/:id" element={<ResultsPage />} />
            <Route path="/mistakes" element={<MistakesPage />} />
            <Route path="/progress" element={<ProgressPage />} />
            <Route path="/create" element={<CreatePage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<HomePage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </I18nProvider>
  )
}

const NAV: { to: string; key: StringKey; icon: string }[] = [
  { to: '/', key: 'nav.today', icon: '◎' },
  { to: '/practice', key: 'nav.practice', icon: '▶' },
  { to: '/mistakes', key: 'nav.mistakes', icon: '✎' },
  { to: '/progress', key: 'nav.progress', icon: '↗' },
  { to: '/settings', key: 'nav.settings', icon: '⚙' },
]

function Shell() {
  const { t } = useI18n()
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-4xl items-center justify-between px-4">
          <NavLink to="/" className="flex items-center gap-2 font-semibold text-ink">
            <img src="/icon.svg" alt="" className="h-7 w-7" />
            {t('app.name')}
          </NavLink>
          <nav className="hidden gap-1 sm:flex">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.to === '/'}
                className={({ isActive }) => `rounded-lg px-3 py-1.5 text-sm ${isActive ? 'bg-surface-2 font-medium text-ink' : 'text-ink-2 hover:text-ink'}`}
              >
                {t(n.key)}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <UpdateBanner />
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 pt-5 pb-24 sm:pb-10">
        <Outlet />
      </main>
      <nav className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/'}
            className={({ isActive }) => `flex flex-col items-center gap-0.5 py-2 text-[11px] ${isActive ? 'text-accent' : 'text-ink-3'}`}
          >
            <span aria-hidden className="text-base leading-none">
              {n.icon}
            </span>
            {t(n.key)}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}

/** New version available → let the learner choose when to reload (never mid-exercise). */
function UpdateBanner() {
  const { t } = useI18n()
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW()
  if (!needRefresh) return null
  return (
    <div className="flex items-center justify-center gap-3 bg-accent-soft px-4 py-2 text-sm text-ink">
      {t('update.available')}
      <button className="font-medium text-accent underline" onClick={() => void updateServiceWorker(true)}>
        {t('update.reload')}
      </button>
    </div>
  )
}
