import { useEffect } from 'react'
import { BrowserRouter, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { startAutoSync } from '../data/sync'
import { CreatePage } from '../features/create/CreatePage'
import { HomePage } from '../features/home/HomePage'
import { MistakesPage } from '../features/mistakes/MistakesPage'
import { QuickReview } from '../features/mistakes/QuickReview'
import { FiblPage } from '../features/listening/FiblPlayer'
import { ListeningResultsPage } from '../features/listening/ListeningResults'
import { WfdPage } from '../features/listening/WfdSession'
import { PlayerPage } from '../features/player/PlayerPage'
import { PracticePage } from '../features/practice/PracticePage'
import { ProgressPage } from '../features/progress/ProgressPage'
import { ReportPage } from '../features/report/ReportPage'
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
        <AutoUpdate />
        <Routes>
          <Route path="/play/:id" element={<PlayerPage />} />
          <Route path="/fibl/:id" element={<FiblPage />} />
          <Route path="/wfd" element={<WfdPage />} />
          <Route element={<Shell />}>
            <Route index element={<HomePage />} />
            <Route path="/practice" element={<PracticePage />} />
            <Route path="/results/:id" element={<ResultsPage />} />
            <Route path="/report/:id" element={<ReportPage />} />
            <Route path="/mistakes" element={<MistakesPage />} />
            <Route path="/review/quick" element={<QuickReview />} />
            <Route path="/listening/:id" element={<ListeningResultsPage />} />
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
  { to: '/mistakes', key: 'nav.review', icon: '✎' },
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
          <div className="flex items-center gap-1">
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
            <LanguageToggle />
          </div>
        </div>
      </header>
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

/** One-tap EN / 中文 switch, always visible in the header. */
function LanguageToggle() {
  const { settings, updateSettings } = useAppState()
  const next = settings.language === 'en' ? 'zh-TW' : 'en'
  return (
    <button
      onClick={() => void updateSettings({ language: next })}
      className="ml-1 rounded-lg border border-line px-2.5 py-1 text-sm text-ink-2 hover:bg-surface-2 hover:text-ink"
      aria-label={next === 'en' ? 'Switch to English' : '切換為中文'}
    >
      {next === 'en' ? 'EN' : '中文'}
    </button>
  )
}

/**
 * Keeps installed copies current without relying on the learner noticing anything:
 * checks for a new version on launch, whenever the app returns to the foreground, and every
 * 30 minutes; applies it automatically — but never mid-exercise (waits until she leaves the player).
 */
function AutoUpdate() {
  const { pathname } = useLocation()
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      if (!reg) return
      const check = () => {
        if (navigator.onLine) void reg.update().catch(() => {})
      }
      setInterval(check, 30 * 60_000)
      document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check())
    },
  })
  useEffect(() => {
    if (needRefresh && !pathname.startsWith('/play/')) void updateServiceWorker(true)
  }, [needRefresh, pathname, updateServiceWorker])
  return null
}
