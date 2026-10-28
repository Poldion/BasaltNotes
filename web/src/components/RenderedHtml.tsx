import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api, enc } from '../lib/api'
import { useApp } from '../lib/state'
import { tr } from '../lib/i18n'

/**
 * Zeigt serverseitig bereinigtes HTML an und fängt Klicks auf interne Links ab.
 * Nicht aufgelöste Links legen (mit Schreibrecht) die Notiz an.
 */
export function RenderedHtml({
  vault,
  html,
  onNavigate,
  onTask,
}: {
  vault: string
  html: string
  onNavigate?: (noteId: string, title: string, type: string) => boolean | void
  /** Aufgabe abgehakt (nur bei anklickbaren Checkboxen mit data-task) */
  onTask?: (index: number, checked: boolean, text: string) => void
}) {
  const navigate = useNavigate()
  const { canWrite, toast } = useApp()
  const { hash } = useLocation()
  // Sprung zu einem Abschnitt (#ueberschrift), sobald der Inhalt da ist
  useEffect(() => {
    if (!hash || hash.length < 2) return
    let id = hash.slice(1)
    try {
      id = decodeURIComponent(id)
    } catch {
      // ungültige Kodierung: so lassen
    }
    document.getElementById(id)?.scrollIntoView({ block: 'start' })
  }, [hash, html])
  return (
    <div
      className="markdown"
      // Inhalt kommt bereinigt vom Server (sanitize-html)
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={async (e) => {
        const box = (e.target as HTMLElement).closest('input[data-task]') as HTMLInputElement | null
        if (box) {
          if (!onTask) return e.preventDefault()
          // Text des Punkts ohne Unterlisten – zur Sicherheit, dass noch dieselbe Aufgabe gemeint ist
          const li = box.closest('li')?.cloneNode(true) as HTMLElement | undefined
          li?.querySelectorAll('ul, ol').forEach((x) => x.remove())
          onTask(Number(box.dataset.task), box.checked, (li?.textContent ?? '').trim())
          return
        }
        const a = (e.target as HTMLElement).closest('a') as HTMLAnchorElement | null
        if (!a) return
        if (a.dataset.noteId) {
          e.preventDefault()
          if (onNavigate?.(a.dataset.noteId, a.textContent ?? '', a.dataset.type ?? '') === true) return
          const anchor = a.getAttribute('href')?.split('#')[1]
          navigate(`/${vault}/note/${enc(a.dataset.noteId)}${anchor ? `#${anchor}` : ''}`)
        } else if (a.dataset.unresolved !== undefined) {
          e.preventDefault()
          if (!canWrite) return
          try {
            const n = await api<{ id: string }>(`/vaults/${enc(vault)}/notes`, { body: { title: a.dataset.unresolved } })
            toast(tr('„{unresolved}“ angelegt', { unresolved: a.dataset.unresolved }), 'success')
            navigate(`/${vault}/note/${enc(n.id)}`)
          } catch (err) {
            toast((err as Error).message, 'error')
          }
        } else if (a.getAttribute('href')?.startsWith('http')) {
          a.target = '_blank'
          a.rel = 'noopener noreferrer'
        }
      }}
    />
  )
}
