import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, enc } from '../lib/api'
import { useApp } from '../lib/state'
import { Modal, TypeDot } from '../lib/ui'
import { tr } from '../lib/i18n'

interface Item {
  id: string
  title: string
  type: string
  path: string
  aliases: string[]
}

/** Einfache unscharfe Bewertung: Präfix > Wortanfang > Teilstring > Buchstabenfolge. */
function score(q: string, text: string): number {
  const t = text.toLowerCase()
  if (!q) return 1
  if (t === q) return 100
  if (t.startsWith(q)) return 80
  if (t.split(/[\s/\-_]+/).some((w) => w.startsWith(q))) return 60
  if (t.includes(q)) return 40
  let i = 0
  for (const c of t) if (c === q[i]) i++
  return i === q.length ? 10 : 0
}

export function QuickSwitcher({ vault, onClose }: { vault: string; onClose: () => void }) {
  const [items, setItems] = useState<Item[]>([])
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const navigate = useNavigate()
  const { canWrite, toast } = useApp()
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api<{ items: Item[] }>(`/vaults/${enc(vault)}/notes?fields=title,type,path,aliases&limit=500&sort=-updated`)
      .then((r) => setItems(r.items))
      .catch(() => undefined)
  }, [vault])

  const results = useMemo(() => {
    const ql = q.trim().toLowerCase()
    return items
      .map((it) => {
        const s = Math.max(score(ql, it.title), ...(it.aliases ?? []).map((a) => score(ql, a) - 5), score(ql, it.path) - 20)
        return { it, s }
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 50)
      .map((x) => x.it)
  }, [items, q])

  const canCreate = canWrite && q.trim() && !results.some((r) => r.title.toLowerCase() === q.trim().toLowerCase())
  const total = results.length + (canCreate ? 1 : 0)

  useEffect(() => setSel(0), [q])
  useEffect(() => {
    listRef.current?.querySelector('.sel')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const open = async (i: number) => {
    if (i < results.length) {
      navigate(`/${vault}/note/${enc(results[i].id)}`)
      onClose()
    } else if (canCreate) {
      try {
        const n = await api<{ id: string }>(`/vaults/${enc(vault)}/notes`, { body: { title: q.trim() } })
        navigate(`/${vault}/note/${enc(n.id)}`)
        onClose()
      } catch (e) {
        toast((e as Error).message, 'error')
      }
    }
  }

  return (
    <Modal onClose={onClose} className="switcher">
      <input
        autoFocus
        placeholder={tr('Notiz suchen oder neu anlegen …')}
        value={q}
        aria-label={tr('Notiz suchen')}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setSel((s) => Math.min(total - 1, s + 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setSel((s) => Math.max(0, s - 1))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            void open(sel)
          }
        }}
      />
      <div className="switcher-list" ref={listRef} role="listbox">
        {results.map((r, i) => (
          <div key={r.id} role="option" aria-selected={i === sel} className={`switcher-item ${i === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => open(i)}>
            <TypeDot type={r.type} />
            <span>{r.title}</span>
            {q && r.aliases?.some((a) => a.toLowerCase().includes(q.toLowerCase())) && <span className="chip">{r.aliases.find((a) => a.toLowerCase().includes(q.toLowerCase()))}</span>}
            <span className="path">{r.path}</span>
          </div>
        ))}
        {canCreate && (
          <div role="option" aria-selected={sel === results.length} className={`switcher-item ${sel === results.length ? 'sel' : ''}`} onMouseEnter={() => setSel(results.length)} onClick={() => open(results.length)}>
            <span className="chip accent">{tr('Neu')}</span> {tr('„{title}“ anlegen', { title: q.trim() })}
          </div>
        )}
        {!total && <div className="empty small">{tr('Keine Treffer')}</div>}
      </div>
      <div className="modal-foot small muted" style={{ justifyContent: 'flex-start' }}>
        <kbd>↑</kbd>
        <kbd>↓</kbd> {tr('wählen ·')}{' '}<kbd>{tr('Enter')}</kbd> {tr('öffnen ·')}{' '}<kbd>{tr('Esc')}</kbd> {tr('schließen')}
      </div>
    </Modal>
  )
}
