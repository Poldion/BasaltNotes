import { useEffect, useRef } from 'react'
import { Route, Routes, useNavigate, useParams } from 'react-router-dom'
import { useApp, type Theme } from '../lib/state'
import { NotePage } from './NotePage'
import { CampaignPage } from './CampaignPage'
import { SearchPage } from './SearchPage'
import { ProposalsPage } from './ProposalsPage'
import { GraphPage } from './GraphPage'
import { postToParent, setAllowedOrigins } from '../lib/embed'
import { tr } from '../lib/i18n'

function EmbedShell({ children }: { children: React.ReactNode }) {
  const { me, setTheme } = useApp()
  const navigate = useNavigate()
  const { vault } = useParams()
  const root = useRef<HTMLDivElement>(null)
  const allowed = [location.origin, ...(me?.embed_origins ?? [])]
  setAllowedOrigins(allowed)

  useEffect(() => {
    postToParent({ type: 'basalt:ready' })
    const ro = new ResizeObserver(() => postToParent({ type: 'basalt:resize', height: Math.ceil(document.documentElement.scrollHeight) }))
    if (root.current) ro.observe(root.current)
    const onMsg = (e: MessageEvent) => {
      if (!allowed.includes(e.origin)) return
      const d = e.data
      if (!d || typeof d !== 'object') return
      if (d.type === 'basalt:open' && d.noteId) navigate(`/embed/${vault}/note/${encodeURIComponent(d.noteId)}${location.search}`)
      else if (d.type === 'basalt:setTheme' && ['light', 'dark', 'auto'].includes(d.theme)) setTheme(d.theme as Theme)
      else if (d.type === 'basalt:search' && typeof d.q === 'string') navigate(`/embed/${vault}/search?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(location.search)), q: d.q })}`)
    }
    window.addEventListener('message', onMsg)
    return () => {
      ro.disconnect()
      window.removeEventListener('message', onMsg)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault, me])

  if (!me)
    return (
      <div className="page">
        <div className="banner danger">{tr('Nicht angemeldet. Bitte im selben Browser bei BasaltNotes anmelden oder ein Embed-Token (')}<code>?token=</code>{tr(') verwenden.')}</div>
      </div>
    )
  return (
    <div className="embed-root" ref={root}>
      {children}
    </div>
  )
}

function EmbedNote() {
  const mode = new URLSearchParams(location.search).get('mode') === 'edit' ? 'edit' : 'view'
  return <NotePage embedMode={mode} />
}

export function EmbedRoutes() {
  return (
    <Routes>
      <Route path="/embed/:vault/note/:id" element={<EmbedShell><EmbedNote /></EmbedShell>} />
      <Route path="/embed/:vault/campaign/:campaign" element={<EmbedShell><CampaignPage embedded /></EmbedShell>} />
      <Route path="/embed/:vault/search" element={<EmbedShell><SearchPage embedded /></EmbedShell>} />
      <Route path="/embed/:vault/proposals" element={<EmbedShell><ProposalsPage embedded /></EmbedShell>} />
      <Route path="/embed/:vault/graph" element={<EmbedShell><GraphPage embedded /></EmbedShell>} />
      <Route path="*" element={<div className="page"><div className="banner danger">{tr('Unbekannte Einbett-Ansicht.')}</div></div>} />
    </Routes>
  )
}
