import { useCallback, useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom'
import { api, enc } from '../lib/api'
import { useApp, useTypes, useVaultEvents } from '../lib/state'
import { FileTree } from './FileTree'
import { QuickSwitcher } from './QuickSwitcher'
import { NewNoteDialog } from './NewNoteDialog'
import { CuratorIndicator } from './CuratorIndicator'
import { registry } from '../lib/plugins'
import { lang, LANGS, setLang, tr } from '../lib/i18n'
import { Icon, NavIcon } from './Icon'

export function Layout() {
  const { vault } = useParams()
  const { vaults, refreshVaults, theme, setTheme, setMe, isAdmin, isPlayer, me, canWrite, toast, features, isAreaLimited } = useApp()
  const [open, setOpen] = useState(false)
  const [switcher, setSwitcher] = useState(false)
  const [newNote, setNewNote] = useState<{ folder?: string } | null>(null)
  const navigate = useNavigate()
  const location = useLocation()
  const current = vaults.find((v) => v.id === vault)
  const types = useTypes(vault)
  const hasJournal = types.some((t) => t.name === 'journal')

  /** Tagebuch-Eintrag für heute öffnen (wird bei Bedarf angelegt) */
  const openToday = async () => {
    if (!vault) return
    const d = new Date()
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    try {
      const n = await api<{ id: string }>(`/vaults/${enc(vault)}/journal/today`, { body: { date } })
      navigate(`/${vault}/note/${enc(n.id)}`)
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  useEffect(() => setOpen(false), [location.pathname])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        setSwitcher(true)
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'f' && vault) {
        e.preventDefault()
        navigate(`/${vault}/search`)
      } else if (e.altKey && e.key.toLowerCase() === 'n' && vault && canWrite) {
        e.preventDefault()
        setNewNote({})
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [vault, navigate, canWrite])

  // Zähler (Vorschläge, Eingang) live halten
  const refresh = useCallback(() => void refreshVaults().catch(() => undefined), [refreshVaults])
  useVaultEvents(vault, (e) => {
    if (e.event.startsWith('proposal.') || e.event.startsWith('inbox.') || e.event === 'run.reverted' || e.event === 'note.created' || e.event === 'note.deleted') refresh()
  })

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined)
    setMe(null)
    navigate('/login')
  }

  const nextTheme = theme === 'auto' ? 'dark' : theme === 'dark' ? 'light' : 'auto'
  const themeLabel = theme === 'auto' ? tr('◐ Auto') : theme === 'dark' ? tr('☾ Dunkel') : tr('☀ Hell')

  return (
    <div className="app">
      <div className={`overlay ${open ? 'open' : ''}`} onClick={() => setOpen(false)} />
      <aside className={`sidebar ${open ? 'open' : ''}`} aria-label={tr('Navigation')}>
        <Link className="brand" to="/" title={tr('Übersicht')}>
          <img src="/icon.svg" alt="" />
          <span>BasaltNotes</span>
        </Link>
        <div className="sidebar-section">
          <label className="sr-only" htmlFor="vault-select">
            {tr('Vault')}
          </label>
          <select
            id="vault-select"
            className="input"
            value={vault ?? ''}
            onChange={(e) => (e.target.value === '__new' ? navigate('/settings#vaults') : navigate(`/${e.target.value}`))}
          >
            {!vault && <option value="">{tr('Vault wählen …')}</option>}
            {vaults.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} ({v.note_count})
              </option>
            ))}
            {isAdmin && <option value="__new">{tr('+ Neuer Vault …')}</option>}
          </select>
        </div>
        {vault && (
          <>
            <div className="sidebar-section">
              <button className="nav-link btn ghost" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => setSwitcher(true)}>
                <span className="nav-icon"><Icon name="switcher" /></span> {tr('Schnellöffner')}{' '}<kbd style={{ marginLeft: 'auto', fontSize: 11 }}>{tr('Strg O')}</kbd>
              </button>
              <NavLink end className="nav-link" to={`/${vault}`}>
                <span className="nav-icon"><Icon name="home" /></span> {tr('Start')}
              </NavLink>
              {hasJournal && canWrite && (
                <button className="nav-link btn ghost" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => void openToday()}>
                  <span className="nav-icon"><Icon name="today" /></span> {tr('Heute')}
                </button>
              )}
              <NavLink className="nav-link" to={`/${vault}/search`}>
                <span className="nav-icon"><Icon name="search" /></span> {tr('Suche')}
              </NavLink>
              {registry.nav
                .filter((n) => !n.visible || n.visible({ vault, types: types.map((t) => t.name) }))
                .map((n) => (
                  <NavLink key={`${n.plugin}:${n.id}`} className="nav-link" to={`/${vault}/${n.path}`}>
                    <span className="nav-icon"><NavIcon icon={n.icon} /></span> {n.label}
                  </NavLink>
                ))}
              {features.chat && (
                <NavLink className="nav-link" to={`/${vault}/chat`}>
                  <span className="nav-icon"><Icon name="chat" /></span> {tr('Fragen')}
                </NavLink>
              )}
              {!isPlayer && features.curator && (
                <>
              <NavLink className="nav-link" to={`/${vault}/inbox`}>
                <span className="nav-icon"><Icon name="inbox" /></span> {tr('Eingang')}
                {!!current?.inbox_pending && <span className="count">{current.inbox_pending}</span>}
              </NavLink>
              <NavLink className="nav-link" to={`/${vault}/proposals`}>
                <span className="nav-icon"><Icon name="sparkle" /></span> {tr('Vorschläge')}
                {!!current?.open_proposals && <span className="count">{current.open_proposals}</span>}
              </NavLink>
              <NavLink className="nav-link" to={`/${vault}/runs`}>
                <span className="nav-icon"><Icon name="log" /></span> {tr('Kurator-Protokoll')}
              </NavLink>
                </>
              )}
              <NavLink className="nav-link" to={`/${vault}/graph`}>
                <span className="nav-icon"><Icon name="graph" /></span> {tr('Graph')}
              </NavLink>
            </div>
            {features.curator && <CuratorIndicator vault={vault} />}
            <div className="row" style={{ padding: '10px 16px 2px' }}>
              <span className="small muted grow" style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', fontSize: 11 }}>
                {tr('Dateien')}
              </span>
              {canWrite && (
                <button className="icon-btn" title={tr('Neue Notiz (Alt+N)')} aria-label={tr('Neue Notiz')} onClick={() => setNewNote({})}>
                  <Icon name="plus" />
                </button>
              )}
            </div>
            <div className="sidebar-scroll">
              <FileTree vault={vault} onNewNote={(folder) => setNewNote({ folder })} />
            </div>
          </>
        )}
        <div className="sidebar-footer">
          <div className="footer-user">
            <span className="avatar" aria-hidden>
              {(me?.display_name ?? me?.name ?? '?').slice(0, 1).toUpperCase()}
            </span>
            <div className="footer-who">
              <span className="footer-name">{me?.display_name ?? me?.name}</span>
              {me?.role && <span className="footer-role">{tr(me.roles?.find((r) => r.name === me.role)?.label ?? me.role)}</span>}
            </div>
            <button className="footer-btn" onClick={logout} title={tr('Abmelden')} aria-label={tr('Abmelden')}>
              <Icon name="logout" />
            </button>
          </div>
          <div className="footer-tools">
            <button className="footer-btn lang-btn" onClick={() => setLang(lang === 'de' ? 'en' : 'de')} title={tr('Sprache: {name} (klicken zum Wechseln)', { name: LANGS.find((l) => l.id === lang)?.label })} aria-label={tr('Sprache wechseln')}>
              {lang.toUpperCase()}
            </button>
            <button className="footer-btn" onClick={() => setTheme(nextTheme)} title={tr('Farbschema: {themeLabel} (klicken zum Wechseln)', { themeLabel: themeLabel })} aria-label={tr('Farbschema wechseln')}>
              <Icon name={theme === 'auto' ? 'auto' : theme === 'dark' ? 'moon' : 'sun'} />
            </button>
            {vault && canWrite && !isAreaLimited && (
              <NavLink className="footer-btn" to={`/${vault}/trash`} title={tr('Papierkorb')} aria-label={tr('Papierkorb')}>
                <Icon name="trash" />
              </NavLink>
            )}
            {vault && !isPlayer && (
              <NavLink className="footer-btn" to={`/${vault}/settings`} title="Vault-Einstellungen" aria-label="Vault-Einstellungen">
                <Icon name="vault" />
              </NavLink>
            )}
            <NavLink className="footer-btn" to="/settings" end title={tr('Einstellungen')} aria-label={tr('Einstellungen')}>
              <Icon name="settings" />
            </NavLink>
          </div>
        </div>
      </aside>
      <main className="main" id="main">
        <div className="topbar">
          <button className="icon-btn" onClick={() => setOpen(true)} aria-label={tr('Menü öffnen')}>
            <Icon name="menu" size={20} />
          </button>
          <strong className="grow">{current?.name ?? 'BasaltNotes'}</strong>
          {vault && (
            <button className="icon-btn" onClick={() => setSwitcher(true)} aria-label={tr('Schnellöffner')}>
              <Icon name="search" size={20} />
            </button>
          )}
        </div>
        <Outlet />
      </main>
      {switcher && vault && <QuickSwitcher vault={vault} onClose={() => setSwitcher(false)} />}
      {newNote && vault && (
        <NewNoteDialog
          vault={vault}
          folder={newNote.folder}
          onClose={() => setNewNote(null)}
          onCreated={(id) => {
            setNewNote(null)
            navigate(`/${vault}/note/${enc(id)}`)
          }}
        />
      )}
    </div>
  )
}
