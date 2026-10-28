import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, enc } from '../lib/api'
import { useApp } from '../lib/state'
import { registry, type PluginInfo } from '../lib/plugins'
import { Modal, Spinner, fmtDateTime, relTime, useConfirm } from '../lib/ui'
import { tr } from '../lib/i18n'
import { Icon } from '../components/Icon'

const SCOPES: [string, string][] = [
  ['read', tr('Lesen')],
  ['write', tr('Schreiben')],
  ['inbox', tr('Nur Eingang')],
  ['curate', tr('Kurator')],
  ['admin', tr('Admin')],
]

export function SettingsPage() {
  const { isAdmin, features } = useApp()
  // Nach dem Speichern der LLM-Einstellungen den Systemstatus neu laden
  const [rev, setRev] = useState(0)
  useEffect(() => {
    document.title = tr('Einstellungen – BasaltNotes')
  }, [])
  return (
    <div className="page">
      <div className="page-header">
        <h1>{tr('Einstellungen')}</h1>
      </div>
      <div className="stack">
        <HealthCard key={rev} />
        {isAdmin && <FeaturesCard />}
        {isAdmin && (features.curator || features.chat) && <LlmCard onSaved={() => setRev((r) => r + 1)} />}
        {isAdmin && <PluginsCard />}
        {registry.settings
          .filter((c) => !c.adminOnly || isAdmin)
          .map((c) => (
            <c.component key={`${c.plugin}:${c.id}`} />
          ))}
        {isAdmin && <UsersCard />}
        {isAdmin && <VaultsCard />}
        {isAdmin && <TokensCard />}
        {isAdmin && <WebhooksCard />}
        <PasswordCard />
        <ApiCard />
      </div>
    </div>
  )
}

function HealthCard() {
  const [h, setH] = useState<any | null>(null)
  const load = (refresh = false) =>
    api(`/health${refresh ? '?refresh=1' : ''}`)
      .then(setH)
      .catch(() => setH(null))
  useEffect(() => void load(), [])
  return (
    <section className="card">
      <div className="card-title">
        {tr('System & LLM')}
        <button className="btn small ghost" style={{ marginLeft: 'auto' }} onClick={() => load(true)}>
          {tr('Neu prüfen')}
        </button>
      </div>
      {!h ? (
        <Spinner />
      ) : (
        <div className="grid-2 small">
          <div className="stack" style={{ gap: 4 }}>
            <div>{tr('Version: {version}', { version: h.version })}</div>
            <div>
              {tr('Vaults: {x}', { x: h.index.vaults.map((v: any) => `${v.name} (${v.notes})`).join(', ') })}
            </div>
            <div>
              {tr('Warteschlange: {queued} wartend · {running} laufend · {failed} fehlgeschlagen', { queued: h.queue.queued, running: h.queue.running, failed: h.queue.failed })}
            </div>
          </div>
          {h.llm.enabled === false ? (
            <div className="small muted">{tr('KI-Funktionen sind aus – kein LLM nötig.')}</div>
          ) : (
          <div className="stack" style={{ gap: 4 }}>
            <div>
              LLM: <code>{h.llm.url}</code> <span className={`chip ${h.llm.reachable ? 'ok' : 'danger'}`}>{h.llm.reachable ? tr('erreichbar') : tr('nicht erreichbar')}</span>
            </div>
            <div>{tr('Aktives Modell: {x}', { x: h.llm.model ?? '–' })}</div>
            <div>
              {tr('Kontextgröße:')}{' '}{h.llm.context} {tr('Tokens')}{' '}<span className="faint">({{ config: tr('Konfiguration'), api_ps: '/api/ps', proxy_state: tr('Proxy /admin/state'), api_show: '/api/show', default: tr('Standard') }[h.llm.context_source as string] ?? h.llm.context_source})</span>
            </div>
            {h.llm.error && <div style={{ color: 'var(--danger)' }}>{h.llm.error}</div>}
          </div>
          )}
        </div>
      )}
    </section>
  )
}

interface User {
  id: string
  username: string
  display_name: string | null
  role: string
  vaults: string[] | '*'
  campaign: string | null
  disabled: boolean
  last_login: string | null
}

type UserEdit = Partial<User> & { password?: string; isNew?: boolean }

function UsersCard() {
  const { me, vaults, toast } = useApp()
  const [items, setItems] = useState<User[] | null>(null)
  const [roles, setRoles] = useState<{ name: string; label: string; scopes: string[] }[]>([])
  const [edit, setEdit] = useState<UserEdit | null>(null)
  const { confirm, el } = useConfirm()
  const load = useCallback(() => {
    api<{ items: User[]; roles: { name: string; label: string; scopes: string[] }[] }>('/users')
      .then((r) => {
        setItems(r.items)
        setRoles(r.roles.map((x) => ({ ...x, label: tr(x.label) })))
      })
      .catch(() => setItems([]))
  }, [])
  useEffect(load, [load])
  const roleLabel = (r: string) => roles.find((x) => x.name === r)?.label ?? r

  const save = async () => {
    if (!edit) return
    const body: Record<string, unknown> = {
      username: edit.username,
      display_name: edit.display_name || null,
      role: edit.role,
      vaults: edit.vaults ?? '*',
      campaign: edit.role === 'player' ? edit.campaign || null : null,
    }
    if (edit.password) body.password = edit.password
    try {
      if (edit.isNew) await api('/users', { body })
      else await api(`/users/${enc(edit.id!)}`, { method: 'PATCH', body })
      toast(edit.isNew ? tr('Benutzer angelegt') : tr('Gespeichert'), 'success')
      setEdit(null)
      load()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  const toggle = async (u: User) => {
    try {
      await api(`/users/${enc(u.id)}`, { method: 'PATCH', body: { disabled: !u.disabled } })
      load()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  const remove = async (u: User) => {
    if (!(await confirm(<>{tr('Benutzer „{username}“ löschen?', { username: u.username })}</>, { yes: tr('Löschen'), danger: true }))) return
    try {
      await api(`/users/${enc(u.id)}`, { method: 'DELETE' })
      load()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  const allVaults = !edit || edit.vaults === '*' || edit.vaults === undefined
  const pwOk = edit ? (edit.isNew ? (edit.password ?? '').length >= 8 : !edit.password || edit.password.length >= 8) : false

  return (
    <section className="card stack" id="users">
      <div className="card-title" style={{ marginBottom: 0 }}>
        {tr('Benutzer')}
        <button className="btn small primary" style={{ marginLeft: 'auto' }} onClick={() => setEdit({ isNew: true, role: 'editor', vaults: '*', username: '', password: '' })}>
          {tr('+ Benutzer')}
        </button>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        {tr('Rollen:')}{' '}<strong>{tr('Administration')}</strong> {tr('(alles inkl. Benutzer und Tokens) ·')}{' '}<strong>{tr('Bearbeiten')}</strong> {tr('(Notizen, Eingang, Kurator) ·')}{' '}<strong>{tr('Lesen')}</strong> · <strong>{tr('Spieler')}</strong> {tr('(nur Inhalte mit')}{' '}<code>{tr('visibility: players')}</code>{tr(', optional auf eine Kampagne beschränkt).')}
      </p>
      {items === null ? (
        <Spinner />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{tr('Benutzer')}</th>
                <th>{tr('Rolle')}</th>
                <th>{tr('Vaults')}</th>
                <th>{tr('Zuletzt angemeldet')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((u) => (
                <tr key={u.id} style={{ opacity: u.disabled ? 0.55 : 1 }}>
                  <td>
                    <strong>{u.display_name || u.username}</strong>
                    <div className="small faint">
                      {u.username}
                      {u.id === me?.user_id && ' (du)'}
                    </div>
                  </td>
                  <td className="small">
                    <span className={`chip ${u.role === 'admin' ? 'accent' : u.role === 'player' ? 'dm' : ''}`}>{roleLabel(u.role)}</span>
                    {u.campaign && <div className="faint">{u.campaign}</div>}
                    {u.disabled && (
                      <div>
                        <span className="chip danger">{tr('gesperrt')}</span>
                      </div>
                    )}
                  </td>
                  <td className="small">{u.vaults === '*' ? tr('alle') : u.vaults.join(', ')}</td>
                  <td className="small faint">{u.last_login ? relTime(u.last_login) : tr('nie')}</td>
                  <td>
                    <div className="row" style={{ flexWrap: 'nowrap' }}>
                      <button className="btn small" onClick={() => setEdit({ ...u, password: '' })}>
                        {tr('Bearbeiten')}
                      </button>
                      {u.id !== me?.user_id && (
                        <>
                          <button className="btn small ghost" onClick={() => toggle(u)}>
                            {u.disabled ? tr('Entsperren') : tr('Sperren')}
                          </button>
                          <button className="btn small ghost" onClick={() => remove(u)} aria-label={tr('{username} löschen', { username: u.username })}>
                            <Icon name="trash" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && (
        <Modal
          title={edit.isNew ? tr('Neuer Benutzer') : tr('Benutzer: {username}', { username: edit.username })}
          onClose={() => setEdit(null)}
          footer={
            <>
              <button className="btn" onClick={() => setEdit(null)}>
                {tr('Abbrechen')}
              </button>
              <button className="btn primary" onClick={save} disabled={!edit.username || !pwOk}>
                {tr('Speichern')}
              </button>
            </>
          }
        >
          <div className="modal-body stack">
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <label className="field grow">
                <span>{tr('Benutzername')}</span>
                <input className="input" autoComplete="off" value={edit.username ?? ''} onChange={(e) => setEdit({ ...edit, username: e.target.value.trim() })} />
              </label>
              <label className="field grow">
                <span>{tr('Anzeigename')}</span>
                <input className="input" value={edit.display_name ?? ''} onChange={(e) => setEdit({ ...edit, display_name: e.target.value })} />
              </label>
            </div>
            <label className="field">
              <span>{edit.isNew ? tr('Passwort (min. 8 Zeichen)') : tr('Neues Passwort (leer lassen = unverändert)')}</span>
              <input className="input" type="password" autoComplete="new-password" value={edit.password ?? ''} onChange={(e) => setEdit({ ...edit, password: e.target.value })} />
            </label>
            <label className="field">
              <span>{tr('Rolle')}</span>
              <select className="input" value={edit.role} disabled={edit.id === me?.user_id} onChange={(e) => setEdit({ ...edit, role: e.target.value })}>
                {roles.map((r) => (
                  <option key={r.name} value={r.name}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="field">
              <span>{tr('Vaults')}</span>
              <div className="row small">
                <label className="row" style={{ gap: 4 }}>
                  <input type="checkbox" checked={allVaults} onChange={(e) => setEdit({ ...edit, vaults: e.target.checked ? '*' : [] })} /> {tr('alle')}
                </label>
                {!allVaults &&
                  vaults.map((v) => {
                    const list = (edit.vaults as string[]) ?? []
                    return (
                      <label key={v.id} className="row" style={{ gap: 4 }}>
                        <input type="checkbox" checked={list.includes(v.id)} onChange={(e) => setEdit({ ...edit, vaults: e.target.checked ? [...list, v.id] : list.filter((x) => x !== v.id) })} /> {v.name}
                      </label>
                    )
                  })}
              </div>
            </div>
            {edit.role === 'player' && (
              <label className="field">
                <span>{tr('Nur Kampagne (optional)')}</span>
                <input className="input" placeholder={tr('z. B. Fluch des Strahd')} value={edit.campaign ?? ''} onChange={(e) => setEdit({ ...edit, campaign: e.target.value })} />
              </label>
            )}
          </div>
        </Modal>
      )}
      {el}
    </section>
  )
}

const PRESET_LABELS: Record<string, string> = { empty: tr('Frei'), notes: tr('Alltag'), dnd: 'D&D' }

function VaultsCard() {
  const { vaults, refreshVaults, toast } = useApp()
  const [name, setName] = useState('')
  const [preset, setPreset] = useState('notes')
  const navigate = useNavigate()
  useEffect(() => {
    if (location.hash === '#vaults') document.getElementById('vaults')?.scrollIntoView()
  }, [])
  const create = async () => {
    try {
      const v = await api<{ id: string }>('/vaults', { body: { name, preset } })
      await refreshVaults()
      navigate(`/${v.id}`)
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  const createExample = async () => {
    try {
      const v = await api<{ id: string }>('/vaults/example', { method: 'POST' })
      await refreshVaults()
      navigate(`/${v.id}`)
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  return (
    <section className="card stack" id="vaults">
      <div className="card-title" style={{ marginBottom: 0 }}>
        {tr('Vaults')}
      </div>
      <div className="list">
        {vaults.map((v) => (
          <div key={v.id} className="list-item">
            <strong>{v.name}</strong>
            <span className="chip">{PRESET_LABELS[v.preset] ?? v.preset}</span>
            <span className="grow small faint">
              {v.note_count} {tr('Notizen · Ordner')}{' '}<code>vaults/{v.id}</code>
            </span>
            <button className="btn small" onClick={() => navigate(`/${v.id}/settings`)}>
              {tr('Einstellungen')}
            </button>
          </div>
        ))}
      </div>
      <div className="row">
        <input className="input" style={{ maxWidth: 260 }} placeholder={tr('Name des neuen Vaults')} value={name} onChange={(e) => setName(e.target.value)} />
        <select className="input" style={{ width: 'auto' }} value={preset} onChange={(e) => setPreset(e.target.value)}>
          <option value="empty">{tr('Frei – nur Notizen, Ordner nach Wahl')}</option>
          <option value="notes">{tr('Vorlage: Alltag (Tagebuch, Aufgaben, Termine …)')}</option>
          <option value="dnd">{tr('Vorlage: D&D')}</option>
        </select>
        <button className="btn primary" disabled={!name.trim()} onClick={create}>
          {tr('Vault anlegen')}
        </button>
        <span className="grow" />
        <button className="btn small" onClick={createExample} title={tr('Erfundene D&D-Kampagne zum Ausprobieren')}>
          {tr('Beispiel-Vault anlegen')}
        </button>
      </div>
    </section>
  )
}

function TokensCard() {
  const { vaults, toast } = useApp()
  const [items, setItems] = useState<any[] | null>(null)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<Set<string>>(new Set(['read', 'inbox']))
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [expires, setExpires] = useState('')
  const [created, setCreated] = useState<string | null>(null)
  /** Zugang für eine App (Freigaben je Notizbuch) oder klassisch (Rechte für alle gewählten Vaults, z. B. Eingang für WhisperNotes) */
  const [mode, setMode] = useState<'grants' | 'scopes'>('grants')
  const [grants, setGrants] = useState<Grant[]>([])
  const [editing, setEditing] = useState<{ id: string; name: string; grants: Grant[] } | null>(null)
  const { confirm, el } = useConfirm()
  const vaultName = (id: string) => vaults.find((v) => v.id === id)?.name ?? id
  const load = useCallback(() => {
    api<{ items: any[] }>('/tokens')
      .then((r) => setItems(r.items))
      .catch(() => setItems([]))
  }, [])
  useEffect(load, [load])
  const create = async () => {
    try {
      const exp = expires ? new Date(expires).toISOString() : null
      const r = await api<{ token: string }>('/tokens', {
        body: mode === 'grants' ? { name, grants, expires: exp } : { name, scopes: [...scopes], vaults: sel.size ? [...sel] : '*', expires: exp },
      })
      setCreated(r.token)
      setName('')
      setGrants([])
      load()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  const saveGrants = async () => {
    if (!editing) return
    try {
      await api(`/tokens/${enc(editing.id)}`, { method: 'PATCH', body: { grants: editing.grants } })
      toast(tr('Freigaben gespeichert'), 'success')
      setEditing(null)
      load()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  const revoke = async (t: any) => {
    if (!(await confirm(<>{tr('Token „{name}“ widerrufen? Apps mit diesem Token verlieren sofort den Zugriff.', { name: t.name })}</>, { yes: tr('Widerrufen'), danger: true }))) return
    await api(`/tokens/${enc(t.id)}`, { method: 'DELETE' })
    load()
  }
  const flip = (s: Set<string>, v: string) => {
    const n = new Set(s)
    if (n.has(v)) n.delete(v)
    else n.add(v)
    return n
  }
  return (
    <section className="card stack">
      <div className="card-title" style={{ marginBottom: 0 }}>
        {tr('API-Tokens')}
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        {tr('Für andere Apps:')}{' '}<code>{tr('Authorization: Bearer <token>')}</code>{tr('. Ein')}{' '}<em>{tr('Zugang für eine App')}</em> {tr('bekommt je Notizbuch Lesen oder Schreiben, optional nur für eine Kampagne, bestimmte Typen oder Ordner (z. B. D&D-Tool: Regarion, nur lesen). WhisperNotes braucht klassisch')}{' '}<em>{tr('Nur Eingang')}</em> + <em>{tr('Lesen')}</em>.
      </p>
      {items === null ? (
        <Spinner />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{tr('Name')}</th>
                <th>{tr('Freigaben')}</th>
                <th>{tr('Zuletzt benutzt')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <td>
                    {t.name}
                    {t.kind !== 'api' && <span className="chip" style={{ marginLeft: 6 }}>{t.kind}</span>}
                    {t.visibility === 'players' && <span className="chip dm" style={{ marginLeft: 6 }}>{tr('Spieler-Sicht')}</span>}
                    {t.expires && <div className="small faint">{tr('läuft ab {x}', { x: fmtDateTime(t.expires) })}</div>}
                  </td>
                  <td className="small">
                    {t.grants ? (
                      t.grants.map((g: Grant) => <div key={g.vault}>{grantSummary(g, vaultName)}</div>)
                    ) : (
                      <>
                        {t.vaults === '*' ? tr('alle Vaults') : t.vaults.map(vaultName).join(', ')}: {t.scopes.join(', ')}
                        {t.campaign ? tr(' – Kampagne {campaign}', { campaign: t.campaign }) : ''}
                      </>
                    )}
                  </td>
                  <td className="small faint">{t.last_used ? relTime(t.last_used) : tr('nie')}</td>
                  <td>
                    <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                      {t.kind === 'api' && t.grants && (
                        <button className="btn small" onClick={() => setEditing({ id: t.id, name: t.name, grants: t.grants ?? [] })}>
                          {tr('Freigaben')}
                        </button>
                      )}
                      <button className="btn small danger" onClick={() => revoke(t)}>
                        {tr('Widerrufen')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="stack" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        <div className="row">
          <input className="input" style={{ maxWidth: 260 }} placeholder={tr('Name, z. B. WhisperNotes')} value={name} onChange={(e) => setName(e.target.value)} />
          <label className="row small">
            {tr('Läuft ab')}{' '}<input className="input" type="date" style={{ width: 'auto' }} value={expires} onChange={(e) => setExpires(e.target.value)} />
          </label>
        </div>
        <div className="tabs" style={{ alignSelf: 'flex-start' }}>
          <button className={mode === 'grants' ? 'active' : ''} onClick={() => setMode('grants')}>
            {tr('Zugang für eine App')}
          </button>
          <button className={mode === 'scopes' ? 'active' : ''} onClick={() => setMode('scopes')}>
            {tr('Klassisch (Eingang, Kurator, Admin)')}
          </button>
        </div>
        {mode === 'grants' ? (
          <GrantEditor value={grants} onChange={setGrants} />
        ) : (
          <>
            <div className="row small">
              <span className="muted">{tr('Rechte:')}</span>
              {SCOPES.map(([v, l]) => (
                <label key={v} className="row" style={{ gap: 4 }}>
                  <input type="checkbox" checked={scopes.has(v)} onChange={() => setScopes(flip(scopes, v))} /> {l}
                </label>
              ))}
            </div>
            <div className="row small">
              <span className="muted">{tr('Vaults (leer = alle):')}</span>
              {vaults.map((v) => (
                <label key={v.id} className="row" style={{ gap: 4 }}>
                  <input type="checkbox" checked={sel.has(v.id)} onChange={() => setSel(flip(sel, v.id))} /> {v.name}
                </label>
              ))}
            </div>
          </>
        )}
        <div>
          <button className="btn primary" disabled={!name.trim() || (mode === 'grants' ? !grants.length : !scopes.size)} onClick={create}>
            {tr('Token erstellen')}
          </button>
        </div>
      </div>
      {editing && (
        <Modal
          title={tr('Freigaben: {name}', { name: editing.name })}
          onClose={() => setEditing(null)}
          footer={
            <>
              <button className="btn" onClick={() => setEditing(null)}>
                {tr('Abbrechen')}
              </button>
              <button className="btn primary" disabled={!editing.grants.length} onClick={saveGrants}>
                {tr('Speichern')}
              </button>
            </>
          }
        >
          <div className="modal-body stack">
            <div className="small muted">{tr('Der Token-Wert bleibt gleich – die App muss nicht neu eingerichtet werden.')}</div>
            <GrantEditor value={editing.grants} onChange={(g) => setEditing({ ...editing, grants: g })} />
          </div>
        </Modal>
      )}
      {created && (
        <Modal title={tr('Neues Token')} onClose={() => setCreated(null)} footer={<button className="btn primary" onClick={() => void navigator.clipboard.writeText(created).then(() => toast(tr('Kopiert')))}>{tr('Kopieren')}</button>}>
          <div className="modal-body stack">
            <div className="banner">{tr('Das Token wird nur jetzt angezeigt. Bitte sicher aufbewahren.')}</div>
            <input className="input mono" readOnly value={created} onFocus={(e) => e.target.select()} />
          </div>
        </Modal>
      )}
      {el}
    </section>
  )
}

function WebhooksCard() {
  const { vaults, toast } = useApp()
  const [items, setItems] = useState<any[] | null>(null)
  const [events, setEvents] = useState<string[]>([])
  const [url, setUrl] = useState('')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [vaultSel, setVaultSel] = useState('')
  const [secret, setSecret] = useState<string | null>(null)
  const load = useCallback(() => {
    api<{ items: any[]; events: string[] }>('/webhooks')
      .then((r) => {
        setItems(r.items)
        setEvents(r.events)
      })
      .catch(() => setItems([]))
  }, [])
  useEffect(load, [load])
  const create = async () => {
    try {
      const r = await api<{ secret: string }>('/webhooks', { body: { url, events: sel.size ? [...sel] : ['*'], vaults: vaultSel ? [vaultSel] : ['*'] } })
      setSecret(r.secret)
      setUrl('')
      load()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  return (
    <section className="card stack">
      <div className="card-title" style={{ marginBottom: 0 }}>
        {tr('Webhooks')}
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        {tr('Signiert mit')}{' '}<code>{tr('X-Basalt-Signature: sha256=HMAC(secret, body)')}</code>{tr('. Fehlgeschlagene Zustellungen werden mit Backoff wiederholt.')}
      </p>
      {items?.map((w) => (
        <details key={w.id} className="card" style={{ padding: 10 }}>
          <summary className="row" style={{ cursor: 'pointer' }}>
            <code className="grow">{w.url}</code>
            <span className="small faint">{w.events.join(', ')}</span>
            <button
              className="btn small danger"
              onClick={async (e) => {
                e.preventDefault()
                await api(`/webhooks/${enc(w.id)}`, { method: 'DELETE' })
                load()
              }}
            >
              {tr('Löschen')}
            </button>
          </summary>
          <table className="table small" style={{ marginTop: 8 }}>
            <tbody>
              {w.deliveries.map((d: any) => (
                <tr key={d.id}>
                  <td>{d.event}</td>
                  <td>
                    <span className={`chip ${d.status === 'delivered' ? 'ok' : d.status === 'failed' ? 'danger' : 'warn'}`}>{d.status}</span>
                  </td>
                  <td>{d.response_code ?? '–'}</td>
                  <td>{d.attempts} {tr('Versuch(e)')}</td>
                  <td className="faint">{d.error ?? ''}</td>
                  <td className="faint">{relTime(d.created)}</td>
                </tr>
              ))}
              {!w.deliveries.length && (
                <tr>
                  <td className="faint">{tr('Noch keine Zustellungen.')}</td>
                </tr>
              )}
            </tbody>
          </table>
        </details>
      ))}
      <div className="row">
        <input className="input" style={{ maxWidth: 360 }} placeholder="https://panel.home/api/basalt-hook" value={url} onChange={(e) => setUrl(e.target.value)} />
        <select className="input" style={{ width: 'auto' }} value={vaultSel} onChange={(e) => setVaultSel(e.target.value)}>
          <option value="">{tr('Alle Vaults')}</option>
          {vaults.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
        <button className="btn primary" disabled={!url} onClick={create}>
          {tr('Webhook anlegen')}
        </button>
      </div>
      <div className="row small">
        <span className="muted">{tr('Ereignisse (leer = alle):')}</span>
        {events.map((e) => (
          <label key={e} className="row" style={{ gap: 4 }}>
            <input
              type="checkbox"
              checked={sel.has(e)}
              onChange={() =>
                setSel((s) => {
                  const n = new Set(s)
                  if (n.has(e)) n.delete(e)
                  else n.add(e)
                  return n
                })
              }
            />
            {e}
          </label>
        ))}
      </div>
      {secret && (
        <Modal title="Webhook-Secret" onClose={() => setSecret(null)}>
          <div className="modal-body stack">
            <div className="banner">{tr('Das Secret wird nur jetzt angezeigt.')}</div>
            <input className="input mono" readOnly value={secret} onFocus={(e) => e.target.select()} />
          </div>
        </Modal>
      )}
    </section>
  )
}

function PasswordCard() {
  const { me, toast } = useApp()
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  if (!me?.user_id) return null
  const save = async () => {
    try {
      await api('/auth/password', { body: { current: cur, new: next } })
      toast(tr('Passwort geändert'), 'success')
      setCur('')
      setNext('')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  return (
    <section className="card stack">
      <div className="card-title" style={{ marginBottom: 0 }}>
        {tr('Passwort ändern')}
      </div>
      <div className="row">
        <input className="input" style={{ maxWidth: 220 }} type="password" placeholder={tr('Aktuelles Passwort')} autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />
        <input className="input" style={{ maxWidth: 220 }} type="password" placeholder={tr('Neues Passwort (min. 8)')} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        <button className="btn primary" disabled={!cur || next.length < 8} onClick={save}>
          {tr('Ändern')}
        </button>
      </div>
    </section>
  )
}

function ApiCard() {
  return (
    <section className="card small stack">
      <div className="card-title" style={{ marginBottom: 0 }}>
        {tr('Schnittstellen')}
      </div>
      <div>
        REST-API: <code>/api/v1</code> {tr('· OpenAPI:')}{' '}<a href="/api/v1/openapi.json">/api/v1/openapi.json</a> {tr('· Live-Ereignisse:')}{' '}<code>/api/v1/events?vault=…</code>
      </div>
      <div>
        {tr('Einbettungen:')}{' '}<code>/embed/&lt;vault&gt;/note/&lt;id&gt;?mode=view|edit</code>, <code>/embed/&lt;vault&gt;/campaign/&lt;kampagne&gt;</code>, <code>/embed/&lt;vault&gt;/search</code>, <code>/embed/&lt;vault&gt;/proposals</code>, <code>/embed/&lt;vault&gt;/graph</code> {tr('– Parameter')}{' '}<code>{tr('theme')}</code>, <code>{tr('visibility')}</code>, <code>links=parent</code>.
      </div>
      <div>
        {tr('Tastenkürzel:')}{' '}<kbd>{tr('Strg')}</kbd>+<kbd>O</kbd> {tr('Schnellöffner ·')}{' '}<kbd>{tr('Strg')}</kbd>+<kbd>⇧</kbd>+<kbd>F</kbd> {tr('Suche ·')}{' '}<kbd>{tr('Alt')}</kbd>+<kbd>N</kbd> {tr('neue Notiz ·')}{' '}<kbd>{tr('Strg')}</kbd>+<kbd>S</kbd> {tr('speichern ·')}{' '}<kbd>{tr('Strg')}</kbd>{tr('+Klick auf Link öffnen ·')}{' '}<kbd>{tr('Strg')}</kbd>+<kbd>K</kbd> {tr('Wiki-Link')}
      </div>
    </section>
  )
}

interface LlmModel {
  name: string
  size: number | null
  parameter_size: string | null
  quantization: string | null
  loaded: boolean
}

type ThinkMode = 'off' | 'on' | 'low' | 'medium' | 'high'

const THINK_OPTIONS: [ThinkMode, string][] = [
  ['off', tr('Aus (schnell)')],
  ['on', tr('An')],
  ['low', tr('Niedrig')],
  ['medium', tr('Mittel')],
  ['high', tr('Hoch (langsam)')],
]

interface LlmSettings {
  url: string
  model: string | null
  num_ctx: number | null
  think_chat: ThinkMode
  think_curator: ThinkMode
  override: { url?: string; model?: string; num_ctx?: number } | null
  env: { url: string | null; model: string | null; num_ctx: number | null; think_chat: string | null; think_curator: string | null }
}

/** LLM-Server und Modell wählen – gilt sofort, ohne Neustart */
export function LlmCard({ onSaved }: { onSaved: () => void }) {
  const { toast } = useApp()
  const { confirm, el } = useConfirm()
  const [cfg, setCfg] = useState<LlmSettings | null>(null)
  const [url, setUrl] = useState('')
  const [model, setModel] = useState('')
  const [ctx, setCtx] = useState('')
  const [thinkChat, setThinkChat] = useState<ThinkMode>('off')
  const [thinkCurator, setThinkCurator] = useState<ThinkMode>('off')
  const [models, setModels] = useState<LlmModel[] | null>(null)
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const apply = (c: LlmSettings) => {
    setCfg(c)
    setUrl(c.url)
    setModel(c.model ?? '')
    setCtx(c.num_ctx ? String(c.num_ctx) : '')
    setThinkChat(c.think_chat ?? 'off')
    setThinkCurator(c.think_curator ?? 'off')
  }

  const test = async (u = url) => {
    setTesting(true)
    setTestError(null)
    try {
      const r = await api<{ models: LlmModel[] }>(`/system/llm/models?url=${enc(u.trim())}`)
      setModels(r.models)
    } catch (e) {
      setModels(null)
      setTestError((e as Error).message)
    } finally {
      setTesting(false)
    }
  }

  useEffect(() => {
    api<LlmSettings>('/system/llm')
      .then((c) => {
        apply(c)
        void test(c.url)
      })
      .catch(() => setCfg(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      const r = await api<LlmSettings & { info: any }>('/system/llm', { method: 'PUT', body: { url: url.trim(), model: model || '', num_ctx: ctx ? Number(ctx) : 0, think_chat: thinkChat, think_curator: thinkCurator } })
      apply(r)
      toast(r.info?.reachable ? tr('Gespeichert – {x} erreichbar', { x: r.info.model ?? tr('Modell') }) : tr('Gespeichert, aber der Server antwortet nicht'), r.info?.reachable ? 'success' : 'error')
      onSaved()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const reset = async () => {
    if (!(await confirm(<>{tr('Eigene LLM-Einstellungen entfernen? Danach gelten wieder die Werte aus der Compose-Datei bzw. die Standardwerte.')}</>, { yes: tr('Zurücksetzen') }))) return
    try {
      const r = await api<LlmSettings>('/system/llm', { method: 'PUT', body: { reset: true } })
      apply(r)
      void test(r.url)
      toast(tr('Zurückgesetzt'), 'success')
      onSaved()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  if (!cfg) return null
  const gb = (n: number | null) => (n ? `${(n / 1e9).toFixed(1)} GB` : '')
  const dirty = url.trim().replace(/\/+$/, '') !== cfg.url || (model || null) !== (cfg.model ?? null) || (ctx ? Number(ctx) : null) !== (cfg.num_ctx ?? null) ||
    thinkChat !== cfg.think_chat ||
    thinkCurator !== cfg.think_curator
  const modelKnown = !model || !models || models.some((m) => m.name === model)

  return (
    <section className="card">
      <div className="card-title">{tr('LLM-Server und Modell')}</div>
      <div className="stack">
        <label className="field">
          <span>{tr('Adresse des Ollama-Servers (bzw. Proxys)')}</span>
          <div className="row">
            <input className="input grow" value={url} placeholder="http://localhost:11434" onChange={(e) => setUrl(e.target.value)} onBlur={() => url.trim() && void test()} />
            <button className="btn" onClick={() => void test()} disabled={testing || !url.trim()}>
              {testing ? <Spinner /> : tr('Verbindung testen')}
            </button>
          </div>
        </label>
        {testError && <div className="small" style={{ color: 'var(--danger)' }}>{testError}</div>}
        {models && !testError && <div className="small muted">{tr('Erreichbar – {length} Modell{x} installiert.', { length: models.length, x: models.length === 1 ? '' : 'e' })}</div>}

        <label className="field">
          <span>{tr('Modell')}</span>
          <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">{tr('Automatisch (das gerade geladene Modell)')}</option>
            {!modelKnown && <option value={model}>{tr('{model} (auf diesem Server nicht gefunden)', { model: model })}</option>}
            {(models ?? []).map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
                {[m.parameter_size, m.quantization, gb(m.size)].filter(Boolean).length ? ` – ${[m.parameter_size, m.quantization, gb(m.size)].filter(Boolean).join(', ')}` : ''}
                {m.loaded ? tr(' · geladen') : ''}
              </option>
            ))}
          </select>
          <span className="small faint">{tr('Ein anderes als das geladene Modell lädt Ollama bei der nächsten Anfrage – das dauert beim ersten Mal etwas.')}</span>
        </label>

        <label className="field">
          <span>{tr('Kontextgröße in Tokens')}</span>
          <input className="input" type="number" min={0} step={1024} value={ctx} placeholder={tr('leer = automatisch erkennen')} onChange={(e) => setCtx(e.target.value)} />
        </label>

        <div className="field">
          <span>{tr('Nachdenken (Thinking)')}</span>
          <div className="grid-2">
            <label className="field">
              <span className="small muted">{tr('im Chat')}</span>
              <select className="input" value={thinkChat} onChange={(e) => setThinkChat(e.target.value as ThinkMode)}>
                {THINK_OPTIONS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="small muted">{tr('beim Kurator')}</span>
              <select className="input" value={thinkCurator} onChange={(e) => setThinkCurator(e.target.value as ThinkMode)}>
                {THINK_OPTIONS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <span className="small faint">
            {tr('Nur bei Modellen, die nachdenken können (z. B. qwen3, deepseek-r1, gpt-oss). Die Stufen Niedrig/Mittel/Hoch versteht nur gpt-oss, andere Modelle behandeln sie wie „An“. Kann ein Modell nicht nachdenken, wird es automatisch ausgeschaltet. Das Nachdenken erzeugt zusätzliche Tokens – bei langsamen Modellen dauert eine Antwort dann deutlich länger.')}
          </span>
        </div>

        {(cfg.env.url || cfg.env.model) && (
          <div className="small faint">
            {tr('Aus der Compose-Datei:')}{' '}{cfg.env.url ? <code>LLM_URL={cfg.env.url}</code> : null} {cfg.env.model ? <code>LLM_MODEL={cfg.env.model}</code> : null}
            {cfg.override ? tr(' – wird durch die Einstellungen hier überschrieben.') : ''}
          </div>
        )}

        <div className="row">
          <button className="btn primary" onClick={save} disabled={saving || !dirty || !url.trim()}>
            {saving ? <Spinner /> : tr('Speichern')}
          </button>
          {cfg.override && (
            <button className="btn ghost" onClick={reset}>
              {tr('Auf Compose-Werte zurücksetzen')}
            </button>
          )}
          <span className="small faint grow" style={{ textAlign: 'right' }}>
            {tr('Gilt sofort für Kurator und Chat, ohne Neustart.')}
          </span>
        </div>
      </div>
      {el}
    </section>
  )
}

// ------------------------------------------------------------ Freigaben je Notizbuch (API-Zugänge)

interface Grant {
  vault: string
  access: 'read' | 'write'
  campaign?: string | null
  shared?: boolean
  folders?: string[]
  types?: string[]
}

/** Kurzbeschreibung einer Freigabe für Tabellen */
function grantSummary(g: Grant, vaultName: (id: string) => string): string {
  const area = [g.campaign ? tr('Kampagne {campaign}{x}', { campaign: g.campaign, x: g.shared === false ? '' : tr(' (+ ohne Kampagne)') }) : '', g.types?.length ? g.types.join(', ') : '', g.folders?.length ? tr('Ordner {x}', { x: g.folders.join(', ') }) : '']
    .filter(Boolean)
    .join(' · ')
  return `${vaultName(g.vault)}: ${g.access === 'write' ? tr('lesen + schreiben') : 'nur lesen'}${area ? ` – ${area}` : ''}`
}

/** Editor: welche Notizbücher, lesen/schreiben, optional Bereich (Kampagne, Typen, Ordner) */
function GrantEditor({ value, onChange }: { value: Grant[]; onChange: (g: Grant[]) => void }) {
  const { vaults } = useApp()
  const [types, setTypes] = useState<Record<string, { name: string; label: string }[]>>({})
  const [campaigns, setCampaigns] = useState<Record<string, string[]>>({})

  useEffect(() => {
    for (const g of value) {
      if (!types[g.vault])
        api<{ items: { name: string; label: string }[] }>(`/vaults/${enc(g.vault)}/types`)
          .then((r) => setTypes((t) => ({ ...t, [g.vault]: r.items })))
          .catch(() => undefined)
      if (!campaigns[g.vault])
        api<{ items: { title: string }[] }>(`/vaults/${enc(g.vault)}/campaigns`)
          .then((r) => setCampaigns((c) => ({ ...c, [g.vault]: r.items.map((x) => x.title) })))
          .catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.map((g) => g.vault).join(',')])

  const set = (vault: string, patch: Partial<Grant> | null) => {
    const has = value.some((g) => g.vault === vault)
    if (patch === null) return onChange(value.filter((g) => g.vault !== vault))
    if (!has) return onChange([...value, { vault, access: 'read', ...patch }])
    onChange(value.map((g) => (g.vault === vault ? { ...g, ...patch } : g)))
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      {vaults.map((v) => {
        const g = value.find((x) => x.vault === v.id)
        const restricted = !!g && (!!g.campaign || !!g.types?.length || !!g.folders?.length)
        return (
          <div key={v.id} className="grant-row">
            <div className="row">
              <label className="row" style={{ gap: 6, minWidth: 160 }}>
                <input type="checkbox" checked={!!g} onChange={(e) => set(v.id, e.target.checked ? {} : null)} />
                <strong>{v.name}</strong>
              </label>
              {g && (
                <select className="input" style={{ width: 'auto' }} value={g.access} onChange={(e) => set(v.id, { access: e.target.value as Grant['access'] })}>
                  <option value="read">{tr('nur lesen')}</option>
                  <option value="write">{tr('lesen + schreiben')}</option>
                </select>
              )}
              {g && !restricted && <span className="small faint">{tr('ganzes Notizbuch')}</span>}
            </div>
            {g && (
              <div className="grant-area">
                {(campaigns[v.id]?.length ?? 0) > 0 && (
                  <label className="row small" style={{ gap: 6 }}>
                    <span className="muted" style={{ minWidth: 80 }}>{tr('Kampagne')}</span>
                    <select className="input" style={{ width: 'auto' }} value={g.campaign ?? ''} onChange={(e) => set(v.id, { campaign: e.target.value || null })}>
                      <option value="">{tr('alle')}</option>
                      {campaigns[v.id].map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                    {g.campaign && (
                      <label className="row" style={{ gap: 4 }}>
                        <input type="checkbox" checked={g.shared !== false} onChange={(e) => set(v.id, { shared: e.target.checked })} /> {tr('auch Einträge ohne Kampagne')}
                      </label>
                    )}
                  </label>
                )}
                <div className="row small" style={{ gap: 6, alignItems: 'flex-start' }}>
                  <span className="muted" style={{ minWidth: 80, paddingTop: 2 }}>{tr('Typen')}</span>
                  <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
                    {(types[v.id] ?? []).map((t) => {
                      const on = !!g.types?.includes(t.name)
                      return (
                        <button
                          key={t.name}
                          type="button"
                          className={`chip ${on ? 'accent' : ''}`}
                          onClick={() => set(v.id, { types: on ? (g.types ?? []).filter((x) => x !== t.name) : [...(g.types ?? []), t.name] })}
                        >
                          {t.label}
                        </button>
                      )
                    })}
                    <span className="faint">{g.types?.length ? '' : '(alle)'}</span>
                  </div>
                </div>
                <label className="row small" style={{ gap: 6 }}>
                  <span className="muted" style={{ minWidth: 80 }}>{tr('Ordner')}</span>
                  <input
                    className="input"
                    style={{ maxWidth: 320 }}
                    placeholder={tr('alle – oder z. B. Rezepte, Tagebuch')}
                    defaultValue={(g.folders ?? []).join(', ')}
                    onBlur={(e) =>
                      set(v.id, {
                        folders: e.target.value
                          .split(',')
                          .map((x) => x.trim().replace(/^\/+|\/+$/g, ''))
                          .filter(Boolean),
                      })
                    }
                  />
                </label>
              </div>
            )}
          </div>
        )
      })}
      <div className="small faint">
        {tr('Mit Bereichs-Einschränkung sieht der Zugang nur passende Einträge (Liste, Suche, Chat, Links) und kann neue nur dort anlegen. Verlauf, Papierkorb, Export, Eingang und Kurator sind dann gesperrt.')}
      </div>
    </div>
  )
}


/** KI-Funktionen ein-/ausschalten – Menüpunkte erscheinen erst, wenn sie an sind */
function FeaturesCard() {
  const { features, refreshMe, toast } = useApp()
  const [busy, setBusy] = useState<string | null>(null)
  const toggle = async (key: 'curator' | 'chat', on: boolean) => {
    setBusy(key)
    try {
      await api('/system/features', { method: 'PUT', body: { [key]: on } })
      await refreshMe()
      toast(`${key === 'curator' ? 'KI-Kurator' : 'KI-Chat'} ${on ? 'eingeschaltet' : 'ausgeschaltet'}`, 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(null)
    }
  }
  return (
    <section className="card stack">
      <div className="card-title" style={{ marginBottom: 0 }}>
        {tr('Funktionen')}
      </div>
      <label className="feature-toggle">
        <input type="checkbox" checked={features.curator} disabled={busy === 'curator'} onChange={(e) => void toggle('curator', e.target.checked)} />
        <div>
          <strong>{tr('KI-Kurator')}</strong>
          <div className="small muted">
            {tr('Sortiert Eingänge (Transkripte, Dokumente) automatisch ein, findet Duplikate, macht Vorschläge. Ausgeschaltet nimmt der Eingang weiter an und legt die Notizen nur ab. Menü: Eingang, Vorschläge, Kurator-Protokoll.')}
          </div>
        </div>
      </label>
      <label className="feature-toggle">
        <input type="checkbox" checked={features.chat} disabled={busy === 'chat'} onChange={(e) => void toggle('chat', e.target.checked)} />
        <div>
          <strong>{tr('KI-Chat')}</strong>
          <div className="small muted">{tr('Fragen an die Notizen stellen. Menü: Fragen.')}</div>
        </div>
      </label>
      <div className="small faint">{tr('Beide brauchen einen LLM-Server (Ollama); die Einstellungen dafür erscheinen, sobald eine KI-Funktion an ist.')}</div>
    </section>
  )
}

/** Plugins ein-/ausschalten */
function PluginsCard() {
  const { toast } = useApp()
  const [items, setItems] = useState<PluginInfo[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    api<{ items: PluginInfo[] }>('/plugins')
      .then((r) => setItems(r.items))
      .catch(() => setItems([]))
  }, [])
  const toggle = async (p: PluginInfo, enabled: boolean) => {
    setBusy(p.id)
    try {
      const r = await api<{ items: PluginInfo[] }>(`/plugins/${enc(p.id)}`, { method: 'PUT', body: { enabled } })
      setItems(r.items)
      toast(tr('„{name}“ {x} – Seite wird neu geladen', { name: p.name, x: enabled ? tr('eingeschaltet') : tr('ausgeschaltet') }), 'success')
      // Oberflächen-Module lassen sich nicht im laufenden Betrieb entladen
      setTimeout(() => window.location.reload(), 800)
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(null)
    }
  }
  return (
    <section className="card stack">
      <div className="card-title" style={{ marginBottom: 0 }}>
        {tr('Plugins')}
      </div>
      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <div className="small faint">{tr('Keine Plugins installiert.')}</div>
      ) : (
        items.map((p) => (
          <label key={p.id} className="feature-toggle">
            <input type="checkbox" checked={p.enabled} disabled={busy === p.id || !!p.error} onChange={(e) => void toggle(p, e.target.checked)} />
            <div>
              <strong>{tr(p.name)}</strong> <span className="small faint">{p.version}{p.builtin ? tr(' · mitgeliefert') : ''}</span>
              {p.description && <div className="small muted">{tr(p.description)}</div>}
              {(p.error || registry.errors[p.id]) && <div className="small" style={{ color: 'var(--danger)' }}>{p.error ?? registry.errors[p.id]}</div>}
            </div>
          </label>
        ))
      )}
      <div className="small faint">
        {tr('Eigene Plugins: Ordner mit')}{' '}<code>manifest.json</code> {tr('unter')}{' '}<code>/data/plugins/</code> {tr('ablegen und den Container neu starten (siehe docs/handbuch.md, „Plugins“).')}
      </div>
    </section>
  )
}
