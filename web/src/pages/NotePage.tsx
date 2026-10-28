import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ApiError, api, enc, qs, type Note } from '../lib/api'
import { invalidateTypes, useApp, useTypes, useVaultEvents } from '../lib/state'
import { Confidence, DiffView, Modal, OP_LABELS, Spinner, TypeDot, fmtDateTime, relTime, useConfirm, useDebounced } from '../lib/ui'
import { Editor, invalidateNames } from '../components/Editor'
import { PropertiesForm } from '../components/PropertiesForm'
import { RenderedHtml } from '../components/RenderedHtml'
import { postToParent } from '../lib/embed'
import { tr } from '../lib/i18n'
import { Icon } from '../components/Icon'

type Mode = 'edit' | 'split' | 'read'
type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'

const RESERVED = ['id', 'created', 'updated', 'title', 'type']

function fmFromNote(n: Note): Record<string, any> {
  const fm: Record<string, any> = { ...n.frontmatter }
  if (n.aliases.length) fm.aliases = n.aliases
  return fm
}

export function NotePage({ embedMode }: { embedMode?: 'view' | 'edit' } = {}) {
  const { vault = '', id = '' } = useParams()
  const navigate = useNavigate()
  const { canWrite, toast, embed } = useApp()
  const types = useTypes(vault)
  const [note, setNote] = useState<Note | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [body, setBody] = useState('')
  const [raw, setRaw] = useState('')
  const [fm, setFm] = useState<Record<string, any>>({})
  const [type, setType] = useState('note')
  const [title, setTitle] = useState('')
  const [rawMode, setRawMode] = useState(false)
  const [mode, setMode] = useState<Mode>(() => {
    if (embedMode === 'view') return 'read'
    try {
      return (localStorage.getItem('basalt:mode') as Mode) ?? 'edit'
    } catch {
      return 'edit'
    }
  })
  const [save, setSave] = useState<SaveState>('saved')
  const [conflict, setConflict] = useState<{ version: string; external: boolean } | null>(null)
  const [sideKey, setSideKey] = useState(0)
  const versionRef = useRef<string>('')
  const dirtyRef = useRef(false)
  const savingRef = useRef(false)
  const readOnly = !canWrite || embedMode === 'view'

  const applyNote = useCallback((n: Note) => {
    setNote(n)
    setBody(n.body)
    setRaw(n.raw ?? '')
    setFm(fmFromNote(n))
    setType(n.type)
    setTitle(n.title)
    versionRef.current = n.version
    dirtyRef.current = false
    setSave('saved')
    setConflict(null)
  }, [])

  const load = useCallback(async () => {
    try {
      const n = await api<Note>(`/vaults/${enc(vault)}/notes/${enc(id)}`)
      applyNote(n)
      setError(null)
      if (!embed) document.title = tr('{title} – BasaltNotes', { title: n.title })
    } catch (e) {
      setError((e as Error).message)
    }
  }, [vault, id, applyNote, embed])

  useEffect(() => {
    setNote(null)
    void load()
  }, [load])

  useEffect(() => {
    if (embedMode) return
    try {
      localStorage.setItem('basalt:mode', mode)
    } catch {
      // ignorieren
    }
  }, [mode, embedMode])

  // ------------------------------------------------------------ Speichern

  const doSave = useCallback(
    async (force = false) => {
      if (!note || readOnly || savingRef.current) return
      if (!dirtyRef.current && !force) return
      savingRef.current = true
      setSave('saving')
      try {
        const payload = rawMode
          ? { raw }
          : {
              frontmatter: (() => {
                const out: Record<string, any> = { id: note.id, type, title: note.title }
                for (const [k, v] of Object.entries(fm)) if (!RESERVED.includes(k)) out[k] = v
                if (note.frontmatter.created !== undefined || note.created) out.created = note.created ?? note.frontmatter.created
                return out
              })(),
              body,
            }
        const n = await api<Note>(`/vaults/${enc(vault)}/notes/${enc(note.id)}`, { method: 'PUT', body: payload, headers: { 'if-match': `"${force ? '*' : versionRef.current}"` } })
        versionRef.current = n.version
        dirtyRef.current = false
        setNote(n)
        if (rawMode) {
          setBody(n.body)
          setFm(fmFromNote(n))
          setType(n.type)
        } else setRaw(n.raw ?? '')
        setSave('saved')
        setConflict(null)
        invalidateNames(vault)
        setSideKey((k) => k + 1)
        if (embed) postToParent({ type: 'basalt:saved', noteId: n.id, version: n.version })
      } catch (e) {
        if (e instanceof ApiError && e.code === 'version_conflict') {
          setSave('conflict')
          setConflict({ version: e.details?.current_version, external: true })
        } else {
          setSave('error')
          toast(tr('Speichern fehlgeschlagen: {message}', { message: (e as Error).message }), 'error')
        }
      } finally {
        savingRef.current = false
      }
    },
    [note, readOnly, rawMode, raw, fm, type, body, vault, toast, embed],
  )

  const markDirty = () => {
    dirtyRef.current = true
    if (save !== 'conflict') setSave('dirty')
  }

  // Autosave
  const changeKey = useDebounced(`${body}\u0000${raw}\u0000${JSON.stringify(fm)}\u0000${type}`, 1200)
  useEffect(() => {
    if (dirtyRef.current && save !== 'conflict') void doSave()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changeKey])

  // Vor dem Verlassen speichern
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        e.preventDefault()
        void doSave()
      }
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [doSave])

  // Live: Änderungen von außen
  useVaultEvents(vault, (e) => {
    if (e.data?.note_id !== id) {
      if (e.event.startsWith('note.')) setSideKey((k) => k + 1)
      return
    }
    if (e.event === 'note.deleted') {
      toast(tr('Diese Notiz wurde gelöscht.'), 'error')
      return
    }
    if (e.event === 'note.renamed') {
      void load()
      return
    }
    if (e.event === 'note.updated' && e.data.version && e.data.version !== versionRef.current && !savingRef.current) {
      if (dirtyRef.current) setConflict({ version: e.data.version, external: true })
      else void load()
    }
  })

  // ------------------------------------------------------------ Aktionen

  const rename = async () => {
    if (!note || title.trim() === note.title || !title.trim()) return setTitle(note?.title ?? '')
    try {
      await doSave()
      const r = await api<Note & { updated_links: number }>(`/vaults/${enc(vault)}/notes/${enc(note.id)}/rename`, { body: { title: title.trim() } })
      applyNote(r)
      invalidateNames(vault)
      toast(r.updated_links ? tr('Umbenannt – {updated_links} Link(s) angepasst', { updated_links: r.updated_links }) : tr('Umbenannt'), 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
      setTitle(note.title)
    }
  }

  const openLink = async (target: string) => {
    const name = target.split('|')[0].split('#')[0].trim()
    try {
      const n = await api<Note>(`/vaults/${enc(vault)}/notes/by-title${qs({ title: name })}`)
      navigate(`/${vault}/note/${enc(n.id)}`)
    } catch {
      if (!canWrite) return
      const n = await api<Note>(`/vaults/${enc(vault)}/notes`, { body: { title: name } })
      invalidateNames(vault)
      navigate(`/${vault}/note/${enc(n.id)}`)
    }
  }

  // ------------------------------------------------------------ Darstellung

  if (error)
    return (
      <div className="page">
        <div className="banner danger">{error}</div>
        <Link to={`/${vault}`}>{tr('Zur Startseite')}</Link>
      </div>
    )
  if (!note)
    return (
      <div className="page">
        <Spinner />
      </div>
    )

  const saveLabel = { saved: tr('Gespeichert'), dirty: tr('Ungespeichert …'), saving: tr('Speichert …'), error: tr('Fehler beim Speichern'), conflict: tr('Konflikt') }[save]
  const folder = note.path.split('/').slice(0, -1).join(' / ')

  return (
    <div className={embed ? '' : 'note-layout'}>
      <div className="note-main">
        <div className="note-toolbar">
          <span className="note-breadcrumb" title={note.path}>
            <TypeDot type={type} /> {folder || tr('Vault')} / <strong>{note.title}</strong>
          </span>
          {!readOnly && (
            <span className={`chip ${save === 'saved' ? 'ok' : save === 'error' || save === 'conflict' ? 'danger' : 'warn'}`} aria-live="polite">
              {saveLabel}
            </span>
          )}
          {embedMode !== 'view' && (
            <div className="tabs" role="tablist" aria-label={tr('Ansicht')}>
              {(['edit', 'split', 'read'] as Mode[]).map((m) => (
                <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>
                  {{ edit: tr('Bearbeiten'), split: tr('Geteilt'), read: tr('Lesen') }[m]}
                </button>
              ))}
            </div>
          )}
          {!readOnly && mode !== 'read' && (
            <button className={`btn small ${rawMode ? 'primary' : ''}`} onClick={async () => {
              await doSave()
              setRawMode(!rawMode)
            }} title={tr('Rohansicht mit Frontmatter')}>
              {'</>'}
            </button>
          )}
          {!embed && <NoteMenu vault={vault} note={note} onReload={load} />}
        </div>

        {conflict && (
          <div className="note-body" style={{ paddingBottom: 0 }}>
            <div className="banner">
              <strong>{tr('Die Notiz wurde inzwischen an anderer Stelle geändert.')}</strong>
              <span className="grow" />
              <button className="btn small" onClick={() => void load()}>
                {tr('Neu laden (eigene Änderungen verwerfen)')}
              </button>
              <button className="btn small danger" onClick={() => void doSave(true)}>
                {tr('Meine Version speichern')}
              </button>
            </div>
          </div>
        )}

        <div className="note-body">
          {mode !== 'read' && !rawMode && (
            <>
              <input
                className="note-title-input"
                value={title}
                aria-label={tr('Titel')}
                readOnly={readOnly}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={rename}
                onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
              />
              <PropertiesForm
                vault={vault}
                types={types}
                type={type}
                frontmatter={fm}
                readOnly={readOnly}
                onChange={(next) => {
                  if (next.type && next.type !== type) setType(next.type)
                  const { type: _t, ...rest } = next
                  setFm(rest)
                  markDirty()
                }}
              />
            </>
          )}
          {mode === 'read' ? (
            <ReadView vault={vault} note={note} version={note.version} canWrite={canWrite && !embed} onChanged={applyNote} />
          ) : mode === 'split' && !rawMode ? (
            <div className="split">
              <Editor vault={vault} value={body} readOnly={readOnly} onChange={(v) => (setBody(v), markDirty())} onSave={() => void doSave(false)} onOpenLink={openLink} />
              <LivePreview vault={vault} markdown={body} />
            </div>
          ) : rawMode ? (
            <Editor vault={vault} value={raw} raw readOnly={readOnly} onChange={(v) => (setRaw(v), markDirty())} onSave={() => void doSave(false)} onOpenLink={openLink} />
          ) : (
            <Editor vault={vault} value={body} readOnly={readOnly} onChange={(v) => (setBody(v), markDirty())} onSave={() => void doSave(false)} onOpenLink={openLink} placeholder={tr('Schreibe los … [[ für Links')} />
          )}
        </div>
      </div>
      {!embed && <SidePanel key={`${note.id}-${sideKey}`} vault={vault} note={note} onRestored={applyNote} />}
    </div>
  )
}

function ReadView({ vault, note, version, canWrite, onChanged }: { vault: string; note: Note; version: string; canWrite?: boolean; onChanged?: (n: Note) => void }) {
  const [html, setHtml] = useState<string | null>(null)
  const params = new URLSearchParams(location.search)
  const { toast } = useApp()
  const toggleTask = async (index: number, checked: boolean, text: string) => {
    try {
      const n = await api<Note>(`/vaults/${enc(vault)}/notes/${enc(note.id)}/tasks/${index}`, { body: { checked, text } })
      onChanged?.(n)
    } catch (e) {
      toast((e as Error).message, 'error')
      onChanged?.(await api<Note>(`/vaults/${enc(vault)}/notes/${enc(note.id)}`))
    }
  }
  useEffect(() => {
    api<string>(`/vaults/${enc(vault)}/notes/${enc(note.id)}/html${qs({ link_base: `/${vault}/note/{id}`, visibility: params.get('visibility') ?? undefined, tasks: canWrite ? 1 : undefined })}`, { text: true })
      .then(setHtml)
      .catch(() => setHtml(tr('<p>Fehler beim Laden.</p>')))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault, note.id, version])
  if (html === null) return <Spinner />
  return (
    <>
      {!startsWithTitle(note) && <h1 style={{ marginTop: 0 }}>{note.title}</h1>}
      <RenderedHtml vault={vault} html={html} onNavigate={(noteId, t, type) => embedNavigate(noteId, t, type)} onTask={canWrite ? (i, c, t) => void toggleTask(i, c, t) : undefined} />
    </>
  )
}

/** Beginnt der Text schon mit „# Titel“? Dann keine zweite Überschrift. */
function startsWithTitle(note: Note): boolean {
  const first = note.body.split('\n').find((l) => l.trim()) ?? ''
  return first.replace(/^#\s+/, '').trim() === note.title && first.trimStart().startsWith('# ')
}

/** In Einbettungen mit links=parent entscheidet der Gast über die Navigation. */
export function embedNavigate(noteId: string, title: string, noteType: string): boolean {
  const p = new URLSearchParams(location.search)
  if (location.pathname.startsWith('/embed/') && p.get('links') === 'parent' && window.parent !== window) {
    postToParent({ type: 'basalt:navigate', noteId, title, noteType })
    return true
  }
  return false
}

function LivePreview({ vault, markdown }: { vault: string; markdown: string }) {
  const debounced = useDebounced(markdown, 400)
  const [html, setHtml] = useState('')
  useEffect(() => {
    const ctrl = new AbortController()
    api<string>(`/vaults/${enc(vault)}/render`, { body: { markdown: debounced, link_base: `/${vault}/note/{id}` }, text: true, signal: ctrl.signal })
      .then(setHtml)
      .catch(() => undefined)
    return () => ctrl.abort()
  }, [vault, debounced])
  return (
    <div style={{ borderLeft: '1px solid var(--border)', paddingLeft: 20 }} aria-label={tr('Vorschau')}>
      <RenderedHtml vault={vault} html={html} />
    </div>
  )
}

// ------------------------------------------------------------ Menü

function NoteMenu({ vault, note, onReload }: { vault: string; note: Note; onReload: () => void }) {
  const [open, setOpen] = useState(false)
  const [curate, setCurate] = useState(false)
  const [linking, setLinking] = useState(false)
  const { canWrite, toast, me, features, vaults } = useApp()
  const linkOnly = vaults.find((v) => v.id === vault)?.curator.mode === 'link'
  const navigate = useNavigate()
  const { confirm, el } = useConfirm()
  const ref = useRef<HTMLButtonElement>(null)
  const rect = ref.current?.getBoundingClientRect()
  const canCurate = me?.scopes.some((s) => ['curate', 'admin'].includes(s))

  const act = async (fn: () => Promise<any>) => {
    setOpen(false)
    try {
      await fn()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  return (
    <>
      <button ref={ref} className="btn small ghost" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} aria-label={tr('Weitere Aktionen')}>
        ⋯
      </button>
      {open && rect && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 110 }} onClick={() => setOpen(false)} />
          <div className="menu" role="menu" style={{ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) }}>
            {canWrite && (
              <button role="menuitem" onClick={() => (setOpen(false), setLinking(true))}>
                <Icon name="link" /> {tr('Erwähnungen verknüpfen …')}
              </button>
            )}
            {canCurate && features.curator && !linkOnly && (
              <button role="menuitem" onClick={() => (setOpen(false), setCurate(true))}>
                <Icon name="sparkle" /> {tr('Durch Kurator laufen lassen …')}
              </button>
            )}
            {features.chat && (
              <button role="menuitem" onClick={() => (setOpen(false), navigate(`/${vault}/chat?focus=${enc(note.id)}`))}>
                <Icon name="chat" /> {tr('Fragen zu dieser Notiz …')}
              </button>
            )}
            <button role="menuitem" onClick={() => act(async () => {
              await navigator.clipboard.writeText(`[[${note.title}]]`)
              toast(tr('Link kopiert'))
            })}>
              {tr('Wiki-Link kopieren')}
            </button>
            <button role="menuitem" onClick={() => act(async () => {
              await navigator.clipboard.writeText(`${location.origin}/embed/${vault}/note/${note.id}?mode=view`)
              toast(tr('Einbett-Link kopiert'))
            })}>
              {tr('Einbett-Link kopieren')}
            </button>
            <button role="menuitem" onClick={() => act(async () => {
              const md = await api<string>(`/vaults/${enc(vault)}/notes/${enc(note.id)}?format=markdown`, { text: true })
              const a = document.createElement('a')
              a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }))
              a.download = note.path.split('/').pop() ?? 'notiz.md'
              a.click()
            })}>
              {tr('Als Markdown herunterladen')}
            </button>
            <button role="menuitem" onClick={() => act(async () => onReload())}>
              {tr('Neu laden')}
            </button>
            {canWrite && (
              <button role="menuitem" className="danger" onClick={() => act(async () => {
                if (!(await confirm(<>{tr('„{title}“ in den Papierkorb verschieben?', { title: note.title })}</>, { yes: tr('Löschen'), danger: true }))) return
                await api(`/vaults/${enc(vault)}/notes/${enc(note.id)}`, { method: 'DELETE' })
                invalidateNames(vault)
                invalidateTypes(vault)
                navigate(`/${vault}`)
              })}>
                {tr('In den Papierkorb')}
              </button>
            )}
          </div>
        </>
      )}
      {curate && <CurateDialog vault={vault} note={note} onClose={() => setCurate(false)} />}
      {linking && <LinkDialog vault={vault} note={note} onClose={() => setLinking(false)} onDone={onReload} />}
      {el}
    </>
  )
}

/** Erwähnungen vorhandener Notizen verlinken (ohne KI): erst Vorschau, dann übernehmen */
function LinkDialog({ vault, note, onClose, onDone }: { vault: string; note: Note; onClose: () => void; onDone: () => void }) {
  const [plan, setPlan] = useState<{ linked: string[]; diff: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { toast } = useApp()
  const url = `/vaults/${enc(vault)}/notes/${enc(note.id)}/link`

  useEffect(() => {
    api<{ linked: string[]; diff: string }>(url, { body: { dry_run: true } })
      .then(setPlan)
      .catch((e) => setError((e as Error).message))
  }, [url])

  const apply = async () => {
    if (!plan) return
    setBusy(true)
    try {
      const r = await api<{ linked: string[] }>(url, { body: { links: plan.linked } })
      toast(r.linked.length ? tr('{length} Verknüpfung(en) gesetzt', { length: r.linked.length }) : tr('Nichts mehr zu verknüpfen'), 'success')
      invalidateNames(vault)
      onDone()
      onClose()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={tr('Verknüpfen: {title}', { title: note.title })}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {tr('Abbrechen')}
          </button>
          <button className="btn primary" onClick={apply} disabled={busy || !plan?.linked.length}>
            {busy ? <Spinner /> : tr('Übernehmen')}
          </button>
        </>
      }
    >
      <div className="modal-body stack">
        <p className="muted small" style={{ margin: 0 }}>
          {tr('Sucht im Text nach Titeln und Aliassen anderer Notizen und macht die jeweils erste Erwähnung zum Link. Es wird nichts angelegt; Rückverweise erscheinen automatisch bei den verlinkten Notizen.')}
        </p>
        {error && <div className="banner danger">{error}</div>}
        {!plan && !error && <Spinner />}
        {plan && !plan.linked.length && <div className="empty small">{tr('Keine unverlinkten Erwähnungen gefunden.')}</div>}
        {plan && plan.linked.length > 0 && (
          <>
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              {plan.linked.map((t) => (
                <span key={t} className="chip">
                  {t}
                </span>
              ))}
            </div>
            <DiffView diff={plan.diff} />
          </>
        )}
      </div>
    </Modal>
  )
}

function CurateDialog({ vault, note, onClose }: { vault: string; note: Note; onClose: () => void }) {
  const [plan, setPlan] = useState<any | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<'auto' | 'review'>('auto')
  const { toast } = useApp()
  const [busy, setBusy] = useState(false)
  const ctrl = useRef<AbortController | null>(null)
  // Dialog schließen bricht einen laufenden Trockenlauf ab (auch auf dem Server)
  useEffect(() => () => ctrl.current?.abort(), [])

  const dry = async () => {
    setBusy(true)
    setError(null)
    ctrl.current = new AbortController()
    try {
      setPlan(await api(`/vaults/${enc(vault)}/notes/${enc(note.id)}/curate${qs({ dry_run: 1, mode })}`, { method: 'POST', signal: ctrl.current.signal }))
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message)
    } finally {
      setBusy(false)
      ctrl.current = null
    }
  }
  const runIt = async () => {
    try {
      await api(`/vaults/${enc(vault)}/notes/${enc(note.id)}/curate${qs({ mode })}`, { method: 'POST' })
      toast(tr('Kurator-Lauf eingereiht – Ergebnis im Protokoll.'), 'success')
      onClose()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  return (
    <Modal
      title={tr('Kurator: {title}', { title: note.title })}
      onClose={onClose}
      footer={
        <>
          <select className="input" style={{ width: 'auto', marginRight: 'auto' }} value={mode} onChange={(e) => setMode(e.target.value as any)}>
            <option value="auto">{tr('Regeln des Vaults (automatisch + Vorschläge)')}</option>
            <option value="review">{tr('Alles als Vorschlag')}</option>
          </select>
          {busy ? (
            <button className="btn danger" onClick={() => ctrl.current?.abort()} title={tr('Trockenlauf abbrechen')}>
              <Spinner /> <Icon name="stop" /> {tr('Abbrechen')}
            </button>
          ) : (
            <button className="btn" onClick={dry}>
              {tr('Trockenlauf')}
            </button>
          )}
          <button className="btn primary" onClick={runIt}>
            {tr('Ausführen')}
          </button>
        </>
      }
    >
      <div className="modal-body stack">
        <p className="muted small" style={{ margin: 0 }}>
          {tr('Der Kurator liest die Notiz, erkennt Charaktere, NPCs, Orte, Quests und Fakten und sortiert sie in den Bestand ein. Der Trockenlauf zeigt nur den Plan, ohne etwas zu ändern.')}
        </p>
        {error && <div className="banner danger">{error}</div>}
        {plan && (
          <>
            <div className="small muted">{tr('{length} geplante Operation(en)', { length: plan.operations.length })}</div>
            {plan.operations.map((op: any, i: number) => (
              <details key={i} className="card" style={{ padding: 10 }}>
                <summary className="row" style={{ cursor: 'pointer' }}>
                  <span className={`chip ${op.auto ? 'ok' : 'warn'}`}>{op.auto ? tr('automatisch') : tr('Vorschlag')}</span>
                  <strong>{OP_LABELS[op.op] ?? op.op}</strong>
                  <span>{op.title ?? op.note_title}</span>
                  {op.alias && <span className="chip">{op.alias}</span>}
                  {op.field && (
                    <span className="small muted">
                      {op.field}: {String(op.from ?? '–')} → {String(op.to)}
                    </span>
                  )}
                  <span className="grow" />
                  <Confidence value={op.confidence} />
                </summary>
                {op.reason && <p className="small muted">{op.reason}</p>}
                {op.diff && <DiffView diff={op.diff} />}
              </details>
            ))}
          </>
        )}
      </div>
    </Modal>
  )
}

// ------------------------------------------------------------ Seitenleiste

function SidePanel({ vault, note, onRestored }: { vault: string; note: Note; onRestored: (n: Note) => void }) {
  const [backlinks, setBacklinks] = useState<any[] | null>(null)
  const [history, setHistory] = useState<any[] | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [rev, setRev] = useState<any | null>(null)
  const navigate = useNavigate()
  const { canWrite, toast } = useApp()

  useEffect(() => {
    api<{ items: any[] }>(`/vaults/${enc(vault)}/notes/${enc(note.id)}/backlinks`)
      .then((r) => setBacklinks(r.items))
      .catch(() => setBacklinks([]))
  }, [vault, note.id])

  useEffect(() => {
    if (!showHistory) return
    api<{ items: any[] }>(`/vaults/${enc(vault)}/notes/${enc(note.id)}/history`)
      .then((r) => setHistory(r.items))
      .catch(() => setHistory([]))
  }, [vault, note.id, showHistory])

  const outgoing = note.links.filter((l, i, arr) => arr.findIndex((x) => x.target === l.target) === i)
  const grouped = new Map<string, any[]>()
  for (const b of backlinks ?? []) {
    const list = grouped.get(b.source_id) ?? []
    list.push(b)
    grouped.set(b.source_id, list)
  }

  const openRev = async (c: any) => {
    const d = await api<{ diff: string }>(`/vaults/${enc(vault)}/notes/${enc(note.id)}/history/${c.rev}?diff=1`)
    setRev({ ...c, diff: d.diff })
  }

  const restore = async () => {
    try {
      const n = await api<Note>(`/vaults/${enc(vault)}/notes/${enc(note.id)}/restore`, { body: { rev: rev.rev } })
      onRestored(n)
      setRev(null)
      toast(tr('Version wiederhergestellt'), 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const create = async (title: string) => {
    if (!canWrite) return
    const n = await api<{ id: string }>(`/vaults/${enc(vault)}/notes`, { body: { title } })
    invalidateNames(vault)
    navigate(`/${vault}/note/${enc(n.id)}`)
  }

  return (
    <aside className="note-side" aria-label={tr('Verknüpfungen')}>
      <div className="side-section">
        <h3>
          {tr('Erwähnt in')}{' '}<span className="chip">{backlinks?.length ?? '…'}</span>
        </h3>
        {backlinks === null ? (
          <Spinner />
        ) : grouped.size === 0 ? (
          <div className="small faint">{tr('Noch keine Rückverweise.')}</div>
        ) : (
          [...grouped.entries()].map(([sid, items]) => (
            <Link key={sid} className="backlink" to={`/${vault}/note/${enc(sid)}`}>
              <span className="row" style={{ gap: 6 }}>
                <TypeDot type={items[0].source_type} /> <strong className="small">{items[0].source_title}</strong>
              </span>
              {items.slice(0, 3).map((b, i) => (
                <span key={i} className="ctx">
                  {b.context}
                </span>
              ))}
            </Link>
          ))
        )}
      </div>
      <div className="side-section">
        <h3>
          {tr('Ausgehende Links')}{' '}<span className="chip">{outgoing.length}</span>
        </h3>
        {outgoing.length === 0 && <div className="small faint">{tr('Keine Links.')}</div>}
        <div className="stack" style={{ gap: 2 }}>
          {outgoing.map((l) =>
            l.attachment ? (
              <a key={l.target} className="small" href={`/api/v1/vaults/${enc(vault)}/attachments/${enc(l.target)}`} target="_blank" rel="noopener">
                <span className="icon-inline">
                  <Icon name="file" />
                </span>
                {l.target}
              </a>
            ) : l.resolved ? (
              <Link key={l.target} className="small" to={`/${vault}/note/${enc(l.target_id!)}`}>
                {l.type && <TypeDot type={l.type} />} {l.target}
              </Link>
            ) : (
              <button key={l.target} className="btn ghost small" style={{ justifyContent: 'flex-start', color: 'var(--unresolved)' }} onClick={() => void create(l.target)} title={tr('Notiz anlegen')}>
                + {l.target}
              </button>
            ),
          )}
        </div>
      </div>
      {note.blocks.length > 0 && (
        <div className="side-section">
          <h3>{tr('Verwaltete Bereiche')}</h3>
          {note.blocks.map((b) => (
            <div key={b.key} className="small row" style={{ gap: 6, marginBottom: 4 }}>
              <span className={`chip ${b.visibility === 'dm' ? 'dm' : 'accent'}`}>{b.visibility === 'dm' ? 'DM' : '⚙'}</span>
              <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }} title={b.key}>
                {b.source_note?.replace(/^\[\[|\]\]$/g, '') ?? b.key}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="side-section">
        <h3>
          {tr('Verlauf')}
          <button className="btn small ghost" onClick={() => setShowHistory(!showHistory)}>
            {showHistory ? tr('ausblenden') : tr('anzeigen')}
          </button>
        </h3>
        {showHistory &&
          (history === null ? (
            <Spinner />
          ) : (
            history.map((c) => (
              <button key={c.rev} className="backlink" style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }} onClick={() => void openRev(c)}>
                <span className="small">{c.message}</span>
                <span className="ctx">
                  {relTime(c.date)} · {c.rev.slice(0, 8)}
                </span>
              </button>
            ))
          ))}
      </div>
      <div className="side-section small muted">
        <h3>{tr('Info')}</h3>
        <div>{tr('Pfad: {path}', { path: note.path })}</div>
        <div>ID: <code>{note.id}</code></div>
        <div>{tr('Angelegt: {x}', { x: fmtDateTime(note.created) })}</div>
        <div>{tr('Geändert: {x}', { x: fmtDateTime(note.updated) })}</div>
        {note.visibility && (
          <div>
            {tr('Sichtbarkeit:')}{' '}<span className={`chip ${note.visibility === 'dm' ? 'dm' : ''}`}>{note.visibility === 'dm' ? tr('nur DM') : tr('Spieler')}</span>
          </div>
        )}
      </div>
      {rev && (
        <Modal
          title={tr('Version {x} – {x2}', { x: rev.rev.slice(0, 8), x2: fmtDateTime(rev.date) })}
          onClose={() => setRev(null)}
          footer={
            <>
              <span className="small muted grow">{rev.message}</span>
              <button className="btn" onClick={() => setRev(null)}>
                {tr('Schließen')}
              </button>
              {canWrite && (
                <button className="btn primary" onClick={restore}>
                  {tr('Diese Version wiederherstellen')}
                </button>
              )}
            </>
          }
        >
          <div className="modal-body">
            <div className="small muted" style={{ marginBottom: 8 }}>
              {tr('Unterschied dieser Version (−) zum aktuellen Stand (+)')}
            </div>
            <DiffView diff={rev.diff} />
          </div>
        </Modal>
      )}
    </aside>
  )
}
