import type { User } from '@supabase/supabase-js'
import { useEffect, useRef, useState } from 'react'
import { useAppState } from '../../app/state'
import { exportBackup, importBackup } from '../../data/repo'
import { getSyncStatus, onSyncStatus, supabase, syncConfigured, syncNow, type SyncStatus } from '../../data/sync'
import { SPEEDS } from '../../domain/types'
import { useI18n } from '../../i18n'
import { relativeTime, speedLabel } from '../../ui/format'
import { Button, Card, PageHeader, Segmented } from '../../ui/kit'

export function SettingsPage() {
  const { settings, updateSettings } = useAppState()
  const { t } = useI18n()
  const fileRef = useRef<HTMLInputElement>(null)
  const [importMsg, setImportMsg] = useState('')

  const download = async () => {
    const blob = await exportBackup()
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `hiw-trainer-backup-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const onImport = async (f: File | undefined) => {
    if (!f) return
    try {
      const n = await importBackup(f)
      setImportMsg(t('settings.imported', { n }))
    } catch {
      setImportMsg(t('settings.importFailed'))
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader title={t('settings.title')} />

      <Card title={t('settings.account')}>
        <AccountPanel />
      </Card>

      <Card>
        <div className="space-y-5">
          <Row label={t('settings.language')}>
            <Segmented
              value={settings.language}
              onChange={(v) => void updateSettings({ language: v })}
              options={[
                { value: 'zh-TW', label: '繁體中文' },
                { value: 'en', label: 'English' },
              ]}
            />
          </Row>
          <Row label={t('settings.theme')}>
            <Segmented
              value={settings.theme}
              onChange={(v) => void updateSettings({ theme: v })}
              options={(['system', 'light', 'dark'] as const).map((v) => ({ value: v, label: t(`settings.theme.${v}`) }))}
            />
          </Row>
          <Row label={t('settings.speed')} note={t('settings.speedNote')}>
            <Segmented value={settings.speed} onChange={(v) => void updateSettings({ speed: v })} options={SPEEDS.map((s) => ({ value: s, label: speedLabel(s) }))} />
          </Row>
          <Row label={t('settings.fading')}>
            <div className="w-full max-w-sm space-y-2 text-sm text-ink-2">
              <label className="flex items-center gap-3">
                <span className="w-40 shrink-0">{t('settings.fadingFull', { n: Math.round(settings.fading.full * 100) })}</span>
                <input
                  type="range"
                  min={0}
                  max={80}
                  step={5}
                  value={settings.fading.full * 100}
                  onChange={(e) => {
                    const full = Number(e.target.value) / 100
                    void updateSettings({ fading: { full, line: Math.min(settings.fading.line, 1 - full) } })
                  }}
                  className="flex-1 accent-[var(--accent)]"
                />
              </label>
              <label className="flex items-center gap-3">
                <span className="w-40 shrink-0">{t('settings.fadingLine', { n: Math.round(settings.fading.line * 100) })}</span>
                <input
                  type="range"
                  min={0}
                  max={Math.round((1 - settings.fading.full) * 100)}
                  step={5}
                  value={settings.fading.line * 100}
                  onChange={(e) => void updateSettings({ fading: { ...settings.fading, line: Number(e.target.value) / 100 } })}
                  className="flex-1 accent-[var(--accent)]"
                />
              </label>
            </div>
          </Row>
          <Row label={t('settings.liveCoaching')}>
            <input
              type="checkbox"
              className="h-5 w-5 accent-[var(--accent)]"
              checked={settings.liveCoaching}
              onChange={(e) => void updateSettings({ liveCoaching: e.target.checked })}
            />
          </Row>
          <Row label={t('settings.countdown')}>
            <Segmented value={settings.examCountdownSec} onChange={(v) => void updateSettings({ examCountdownSec: v })} options={[3, 7, 10].map((s) => ({ value: s, label: `${s}` }))} />
          </Row>
        </div>
      </Card>

      <Card title={t('settings.install')}>
        <p className="text-sm text-ink-2">{t('settings.installHint')}</p>
      </Card>

      <Card title={t('settings.backup')}>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void download()}>{t('settings.export')}</Button>
          <Button onClick={() => fileRef.current?.click()}>{t('settings.import')}</Button>
          <input ref={fileRef} type="file" accept="application/json" className="hidden" onChange={(e) => void onImport(e.target.files?.[0])} />
          {importMsg && <span className="text-sm text-ink-2">{importMsg}</span>}
        </div>
      </Card>

      <Card title={t('settings.about')}>
        <ul className="space-y-1.5 text-sm text-ink-2">
          <li>{t('settings.aboutAudio')}</li>
          <li>{t('settings.aboutPrivacy')}</li>
          <li>{t('results.simulation')}</li>
          <li className="text-ink-3">
            {t('settings.version')}: {__BUILD__}
          </li>
        </ul>
      </Card>
    </div>
  )
}

function Row({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="text-sm font-medium text-ink">{label}</div>
        {note && <div className="text-xs text-ink-3">{note}</div>}
      </div>
      {children}
    </div>
  )
}

function AccountPanel() {
  const { t, lang } = useI18n()
  const [user, setUser] = useState<User | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [status, setStatus] = useState<SyncStatus>(getSyncStatus())

  useEffect(() => {
    if (!supabase) return
    void supabase.auth.getUser().then(({ data }) => setUser(data.user))
    const { data } = supabase.auth.onAuthStateChange((_e, session) => setUser(session?.user ?? null))
    const off = onSyncStatus(setStatus)
    return () => {
      data.subscription.unsubscribe()
      off()
    }
  }, [])

  if (!syncConfigured || !supabase) return <p className="text-sm text-ink-3">{t('settings.syncUnavailable')}</p>

  const auth = async (kind: 'in' | 'up') => {
    setBusy(true)
    setErr('')
    const res =
      kind === 'in'
        ? await supabase!.auth.signInWithPassword({ email: email.trim(), password })
        : await supabase!.auth.signUp({ email: email.trim(), password })
    setBusy(false)
    if (res.error) setErr(t('settings.authError', { error: res.error.message }))
    else if (kind === 'up' && !res.data.session) {
      // Email confirmation is enabled on the project; fall back to signing in.
      const r2 = await supabase!.auth.signInWithPassword({ email: email.trim(), password })
      if (r2.error) setErr(t('settings.authError', { error: r2.error.message }))
    }
  }

  const statusText =
    status.state === 'idle'
      ? t('settings.sync.idle', { time: status.at ? relativeTime(status.at, lang) : '' })
      : status.state === 'error'
        ? t('settings.sync.error', { error: status.error ?? '' })
        : t(`settings.sync.${status.state}`)

  if (user) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-ink">{t('settings.signedInAs', { email: user.email ?? '' })}</p>
        <p className={`text-sm ${status.state === 'error' ? 'text-bad' : 'text-ink-2'}`}>{statusText}</p>
        <div className="flex gap-2">
          <Button onClick={() => void syncNow()} disabled={status.state === 'syncing'}>
            {t('settings.syncNow')}
          </Button>
          <Button variant="ghost" onClick={() => void supabase!.auth.signOut()}>
            {t('settings.signOut')}
          </Button>
        </div>
      </div>
    )
  }

  const input = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none'
  return (
    <form
      className="max-w-sm space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        void auth('in')
      }}
    >
      <p className="text-sm text-ink-2">{t('settings.accountNote')}</p>
      <input className={input} type="email" autoComplete="email" placeholder={t('settings.email')} value={email} onChange={(e) => setEmail(e.target.value)} required />
      <input
        className={input}
        type="password"
        autoComplete="current-password"
        placeholder={t('settings.password')}
        minLength={6}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      {err && <p className="text-sm text-bad">{err}</p>}
      <div className="flex gap-2">
        <Button variant="primary" type="submit" disabled={busy}>
          {t('settings.signIn')}
        </Button>
        <Button type="button" disabled={busy || !email || password.length < 6} onClick={() => void auth('up')}>
          {t('settings.signUp')}
        </Button>
      </div>
    </form>
  )
}
