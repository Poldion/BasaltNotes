import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, enc, qs } from '../lib/api'
import { useApp, useVaultEvents } from '../lib/state'
import { TypeDot, useConfirm, usePrompt } from '../lib/ui'
import { tr } from '../lib/i18n'
import { Icon } from './Icon'

interface TreeNote {
  id: string
  path: string
  title: string
  type: string
}

interface Folder {
  name: string
  path: string
  folders: Map<string, Folder>
  notes: TreeNote[]
}

function buildTree(folders: string[], notes: TreeNote[]): Folder {
  const root: Folder = { name: '', path: '', folders: new Map(), notes: [] }
  const ensure = (p: string): Folder => {
    if (!p) return root
    const parts = p.split('/')
    let cur = root
    let acc = ''
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part
      let f = cur.folders.get(part)
      if (!f) {
        f = { name: part, path: acc, folders: new Map(), notes: [] }
        cur.folders.set(part, f)
      }
      cur = f
    }
    return cur
  }
  for (const f of folders) ensure(f)
  for (const n of notes) {
    const i = n.path.lastIndexOf('/')
    ensure(i >= 0 ? n.path.slice(0, i) : '').notes.push(n)
  }
  return root
}

const HIDDEN = new Set(['_inbox', '_attachments'])

export function FileTree({ vault, onNewNote }: { vault: string; onNewNote: (folder?: string) => void }) {
  const { id: activeId } = useParams()
  const { toast, canWrite, isAreaLimited } = useApp()
  const navigate = useNavigate()
  const [data, setData] = useState<{ folders: string[]; notes: TreeNote[] } | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(`basalt:tree:${vault}`) ?? '[]'))
    } catch {
      return new Set()
    }
  })
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [actionsFor, setActionsFor] = useState<string | null>(null)
  const { ask, el: promptEl } = usePrompt()
  const { confirm, el: confirmEl } = useConfirm()

  const load = useCallback(() => {
    api<{ folders: string[]; notes: TreeNote[] }>(`/vaults/${enc(vault)}/tree`)
      .then(setData)
      .catch(() => undefined)
  }, [vault])

  useEffect(load, [load])
  useVaultEvents(vault, (e) => {
    if (e.event.startsWith('note.') || e.event === 'inbox.processed' || e.event === 'run.reverted') load()
  })

  useEffect(() => {
    try {
      localStorage.setItem(`basalt:tree:${vault}`, JSON.stringify([...expanded]))
    } catch {
      // ignorieren
    }
  }, [expanded, vault])

  // Ordner der aktiven Notiz aufklappen
  useEffect(() => {
    if (!data || !activeId) return
    const n = data.notes.find((x) => x.id === activeId)
    if (!n) return
    const parts = n.path.split('/').slice(0, -1)
    const add: string[] = []
    let acc = ''
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p
      if (!expanded.has(acc)) add.push(acc)
    }
    if (add.length) setExpanded((s) => new Set([...s, ...add]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, data])

  const tree = useMemo(() => (data ? buildTree(data.folders.filter((f) => !HIDDEN.has(f.split('/')[0])), data.notes) : null), [data])

  const toggle = (p: string) =>
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(p)) n.delete(p)
      else n.add(p)
      return n
    })

  const run = async (fn: () => Promise<any>, ok?: string) => {
    try {
      await fn()
      if (ok) toast(ok, 'success')
      load()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const newFolder = async (parent: string) => {
    const name = await ask(tr('Neuer Ordner'), tr('Name'), '')
    if (!name) return
    const path = parent ? `${parent}/${name}` : name
    await run(() => api(`/vaults/${enc(vault)}/folders`, { body: { path } }))
    setExpanded((s) => new Set([...s, parent, path].filter(Boolean)))
  }
  const renameFolder = async (f: Folder) => {
    const to = await ask(tr('Ordner umbenennen'), tr('Neuer Pfad'), f.path)
    if (!to || to === f.path) return
    await run(() => api(`/vaults/${enc(vault)}/folders`, { method: 'PATCH', body: { from: f.path, to } }), tr('Ordner umbenannt'))
  }
  const deleteFolder = async (f: Folder) => {
    if (!(await confirm(<>{tr('Ordner „{path}“ löschen? Enthaltene Notizen wandern in den Papierkorb.', { path: f.path })}</>, { yes: tr('Löschen'), danger: true }))) return
    await run(() => api(`/vaults/${enc(vault)}/folders${qs({ path: f.path })}`, { method: 'DELETE' }), tr('Ordner gelöscht'))
  }
  const renameNote = async (n: TreeNote) => {
    const title = await ask(tr('Umbenennen'), tr('Neuer Titel (Links werden angepasst)'), n.title)
    if (!title || title === n.title) return
    await run(() => api(`/vaults/${enc(vault)}/notes/${enc(n.id)}/rename`, { body: { title } }), tr('Umbenannt, Links angepasst'))
  }
  const deleteNote = async (n: TreeNote) => {
    if (!(await confirm(<>{tr('„{title}“ in den Papierkorb verschieben?', { title: n.title })}</>, { yes: tr('Löschen'), danger: true }))) return
    await run(() => api(`/vaults/${enc(vault)}/notes/${enc(n.id)}`, { method: 'DELETE' }))
    if (n.id === activeId) navigate(`/${vault}`)
  }
  const moveNote = async (id: string, folder: string) => {
    await run(() => api(`/vaults/${enc(vault)}/notes/${enc(id)}/rename`, { body: { folder } }), tr('Verschoben'))
  }
  /** Verschieben ohne Ziehen (Touch) */
  const askMoveNote = async (n: TreeNote) => {
    const current = n.path.split('/').slice(0, -1).join('/')
    const to = await ask(tr('Verschieben'), tr('Zielordner (/ = oberste Ebene)'), current || '/')
    if (!to) return
    const folder = to.replace(/^\/+|\/+$/g, '')
    if (folder !== current) await moveNote(n.id, folder)
  }
  /** Touch: Aktionen einer Zeile erscheinen erst nach Tipp auf ⋮ (kein Hover) */
  const moreButton = (key: string) => (
    <button
      className="icon-btn tree-more"
      aria-label={tr('Aktionen')}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setActionsFor((cur) => (cur === key ? null : key))
      }}
    >
      ⋮
    </button>
  )

  const dropProps = (folder: string) =>
    canWrite
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (e.dataTransfer.types.includes('application/x-basalt-note')) {
              e.preventDefault()
              setDropTarget(folder)
            }
          },
          onDragLeave: () => setDropTarget((t) => (t === folder ? null : t)),
          onDrop: (e: React.DragEvent) => {
            e.preventDefault()
            setDropTarget(null)
            const id = e.dataTransfer.getData('application/x-basalt-note')
            if (id) void moveNote(id, folder)
          },
        }
      : {}

  const renderFolder = (f: Folder, depth: number): React.ReactNode => {
    const folders = [...f.folders.values()].sort((a, b) => a.name.localeCompare(b.name, 'de'))
    const notes = [...f.notes].sort((a, b) => a.title.localeCompare(b.title, 'de'))
    return (
      <>
        {folders.map((sub) => {
          const isOpen = expanded.has(sub.path)
          return (
            <div key={sub.path} role="treeitem" aria-expanded={isOpen}>
              <div
                className={`tree-row ${dropTarget === sub.path ? 'drop' : ''}`}
                style={{ paddingLeft: 6 + depth * 14 }}
                onClick={() => toggle(sub.path)}
                tabIndex={0}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle(sub.path))}
                {...dropProps(sub.path)}
              >
                <span className="tree-caret">{<Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={12} />}</span>
                <span className="label">{sub.name}</span>
                {canWrite && moreButton(sub.path)}
                {canWrite && (
                  <span className={`actions ${actionsFor === sub.path ? 'open' : ''}`} onClick={(e) => e.stopPropagation()}>
                    <button className="icon-btn" title={tr('Neue Notiz hier')} onClick={() => onNewNote(sub.path)}>
                      <Icon name="plus" />
                    </button>
                    <button className="icon-btn" title={tr('Unterordner')} onClick={() => newFolder(sub.path)}>
                      <Icon name="folderPlus" />
                    </button>
                    <button className="icon-btn" title={tr('Umbenennen')} onClick={() => renameFolder(sub)}>
                      <Icon name="edit" />
                    </button>
                    <button className="icon-btn" title={tr('Löschen')} onClick={() => deleteFolder(sub)}>
                      <Icon name="trash" />
                    </button>
                  </span>
                )}
              </div>
              {isOpen && <div role="group">{renderFolder(sub, depth + 1)}</div>}
            </div>
          )
        })}
        {notes.map((n) => (
          <Link
            key={n.id}
            to={`/${vault}/note/${enc(n.id)}`}
            className={`tree-row ${n.id === activeId ? 'active' : ''}`}
            style={{ paddingLeft: 20 + depth * 14 }}
            draggable={canWrite}
            onDragStart={(e) => e.dataTransfer.setData('application/x-basalt-note', n.id)}
            role="treeitem"
            title={n.path}
          >
            <TypeDot type={n.type} />
            <span className="label">{n.title}</span>
            {canWrite && moreButton(n.id)}
            {canWrite && (
              <span className={`actions ${actionsFor === n.id ? 'open' : ''}`} onClick={(e) => e.preventDefault()}>
                <button className="icon-btn" title={tr('Umbenennen')} onClick={() => renameNote(n)}>
                  <Icon name="edit" />
                </button>
                <button className="icon-btn" title={tr('Verschieben')} onClick={() => askMoveNote(n)}>
                  <Icon name="folderPlus" />
                </button>
                <button className="icon-btn" title={tr('Löschen')} onClick={() => deleteNote(n)}>
                  <Icon name="trash" />
                </button>
              </span>
            )}
          </Link>
        ))}
      </>
    )
  }

  if (!tree) return <div className="small muted" style={{ padding: 8 }}>{tr('Lädt …')}</div>
  return (
    <div className="tree" role="tree" aria-label={tr('Dateien')}>
      <div className={`row ${dropTarget === '' ? 'tree-row drop' : ''}`} {...dropProps('')} style={{ minHeight: 4 }} />
      {renderFolder(tree, 0)}
      {canWrite && !isAreaLimited && (
        <button className="btn small ghost" style={{ marginTop: 8 }} onClick={() => newFolder('')}>
          {tr('+ Ordner')}
        </button>
      )}
      {promptEl}
      {confirmEl}
    </div>
  )
}
