import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api, type Me } from '../lib/api'
import { useApp } from '../lib/state'
import { lang, LANGS, setLang, tr } from '../lib/i18n'

export function LoginPage() {
  const { setMe, refreshVaults } = useApp()
  const [username, setUsername] = useState(() => {
    try {
      return localStorage.getItem('basalt:lastUser') ?? ''
    } catch {
      return ''
    }
  })
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api('/auth/login', { body: { username, password } })
      try {
        localStorage.setItem('basalt:lastUser', username)
      } catch {
        // ignorieren
      }
      const me = await api<Me>('/auth/me')
      setMe(me)
      await refreshVaults()
      const from = (location.state as any)?.from
      navigate(from && from !== '/login' ? from : '/', { replace: true })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <form className="card stack" onSubmit={submit}>
        <div className="row" style={{ gap: 12 }}>
          <img src="/icon.svg" alt="" width={40} height={40} />
          <div>
            <h1 style={{ margin: 0, fontSize: 22 }}>BasaltNotes</h1>
            <div className="small muted">{tr('Notizen · Wiki · KI-Kurator')}</div>
          </div>
        </div>
        {error && <div className="banner danger">{error}</div>}
        <label className="field">
          <span>{tr('Benutzername')}</span>
          <input className="input" autoComplete="username" autoFocus={!username} value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="field">
          <span>{tr('Passwort')}</span>
          <input className="input" type="password" autoComplete="current-password" autoFocus={!!username} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button className="btn primary" disabled={busy || !password || !username}>
          {busy ? tr('Anmelden …') : tr('Anmelden')}
        </button>
        <p className="small faint" style={{ margin: 0 }}>
          {tr('Erster Start: Benutzer')}{' '}<code>admin</code>{tr(', Passwort aus')}{' '}<code>ADMIN_PASSWORD</code> {tr('oder aus dem Container-Log. Weitere Konten legt ein Admin unter Einstellungen → Benutzer an.')}
        </p>
        <div className="row small" style={{ justifyContent: 'flex-end', gap: 8 }}>
          {LANGS.map((l) => (
            <button key={l.id} type="button" className={`btn small ghost${l.id === lang ? ' primary' : ''}`} onClick={() => l.id !== lang && setLang(l.id)}>
              {l.label}
            </button>
          ))}
        </div>
      </form>
    </div>
  )
}
