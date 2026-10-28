import { useEffect, useState } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { api, getToken, type Me } from './lib/api'
import { useApp } from './lib/state'
import { Spinner } from './lib/ui'
import { Layout } from './components/Layout'
import { LoginPage } from './pages/LoginPage'
import { VaultHome } from './pages/VaultHome'
import { NotePage } from './pages/NotePage'
import { SearchPage } from './pages/SearchPage'
import { ChatPage } from './pages/ChatPage'
import { SetupPage } from './pages/SetupPage'
import { InboxPage } from './pages/InboxPage'
import { ProposalsPage } from './pages/ProposalsPage'
import { RunsPage } from './pages/RunsPage'
import { CampaignPage } from './pages/CampaignPage'
import { GraphPage } from './pages/GraphPage'
import { TrashPage } from './pages/TrashPage'
import { VaultSettingsPage } from './pages/VaultSettingsPage'
import { SettingsPage } from './pages/SettingsPage'
import { EmbedRoutes } from './pages/Embed'
import { loadPlugins, registry } from './lib/plugins'

export function App() {
  const { me, setMe, refreshVaults, vaults, embed, toasts, isAdmin, features } = useApp()
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    let alive = true
    api<Me>('/auth/me')
      .then(async (m) => {
        if (!alive) return
        setMe(m)
        // Oberflächen der eingeschalteten Plugins vor dem ersten Zeichnen laden
        await Promise.all([refreshVaults(), loadPlugins()])
      })
      .catch(() => alive && setMe(null))
      .finally(() => alive && setLoading(false))
    const onUnauth = () => {
      setMe(null)
      if (!getToken()) navigate('/login', { state: { from: location.pathname } })
    }
    window.addEventListener('basalt:unauthorized', onUnauth)
    return () => {
      alive = false
      window.removeEventListener('basalt:unauthorized', onUnauth)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toastEl = (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  )

  if (loading)
    return (
      <div className="login">
        <Spinner />
      </div>
    )

  if (embed)
    return (
      <>
        <EmbedRoutes />
        {toastEl}
      </>
    )

  if (!me)
    return (
      <>
        <Routes>
          <Route path="*" element={<LoginPage />} />
        </Routes>
        {toastEl}
      </>
    )

  // Erste Anmeldung eines Admins: Funktionen wählen
  if (isAdmin && !features.setup_done)
    return (
      <>
        <SetupPage />
        {toastEl}
      </>
    )

  const first = vaults[0]?.id
  return (
    <>
      <Routes>
        <Route path="/login" element={<Navigate to={first ? `/${first}` : '/settings'} replace />} />
        <Route path="/settings" element={<Layout />}>
          <Route index element={<SettingsPage />} />
        </Route>
        <Route path="/p" element={<Layout />}>
          {registry.pages
            .filter((pg) => pg.scope === 'global')
            .map((pg) => (
              <Route key={`${pg.plugin}:${pg.path}`} path={`${pg.path}/*`} element={<pg.component />} />
            ))}
        </Route>
        <Route path="/:vault" element={<Layout />}>
          <Route index element={<VaultHome />} />
          <Route path="note/:id" element={<NotePage />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="chat" element={<ChatPage />} />
          {registry.pages
            .filter((pg) => pg.scope === 'vault')
            .map((pg) => (
              <Route key={`${pg.plugin}:${pg.path}`} path={`${pg.path}/*`} element={<pg.component />} />
            ))}
          <Route path="inbox" element={<InboxPage />} />
          <Route path="proposals" element={<ProposalsPage />} />
          <Route path="runs" element={<RunsPage />} />
          <Route path="runs/:runId" element={<RunsPage />} />
          <Route path="campaign/:campaign" element={<CampaignPage />} />
          <Route path="graph" element={<GraphPage />} />
          <Route path="trash" element={<TrashPage />} />
          <Route path="settings" element={<VaultSettingsPage />} />
        </Route>
        <Route path="*" element={first ? <Navigate to={`/${first}`} replace /> : <Navigate to="/settings" replace />} />
      </Routes>
      {toastEl}
    </>
  )
}
