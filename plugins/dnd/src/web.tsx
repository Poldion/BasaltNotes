import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { TypeDot, api, enc, slugify, tr, useVaultEvents, type ActivatePlugin } from '@basaltnotes/plugin-sdk/web'
import { CampaignPage } from './CampaignPage.js'

interface Campaign {
  id: string | null
  title: string
  slug: string
  status: string | null
  system: string | null
  players: any[]
}

/** Kampagnen auf der Startseite des Notizbuchs */
function CampaignsSection({ vault }: { vault: string }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const load = () => {
    api<{ items: Campaign[] }>(`/vaults/${enc(vault)}/campaigns`)
      .then((r) => setCampaigns(r.items))
      .catch(() => setCampaigns([]))
  }
  useEffect(load, [vault])
  useVaultEvents(vault, (e) => {
    if (e.event.startsWith('note.')) load()
  })
  if (!campaigns.length) return null
  return (
    <section style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 16 }}>{tr('Kampagnen')}</h2>
      <div className="grid-2">
        {campaigns.map((c) => (
          <Link key={c.title} to={`/${vault}/campaign/${c.slug || slugify(c.title)}`} className="card" style={{ color: 'inherit', textDecoration: 'none' }}>
            <div className="card-title">
              <TypeDot type="campaign" /> {c.title}
            </div>
            <div className="row small muted">
              {c.system && <span className="chip">{c.system}</span>}
              {c.status && <span className="chip accent">{tr(c.status)}</span>}
              {c.players?.length > 0 && <span>{tr('{length} Spielende', { length: c.players.length })}</span>}
            </div>
          </Link>
        ))}
      </div>
    </section>
  )
}

const activate: ActivatePlugin = (ctx) => {
  ctx.registerPage({ path: 'campaign/:campaign', component: CampaignPage, embed: true })
  ctx.registerHomeSection({ id: 'campaigns', order: 10, component: CampaignsSection })
}

export default activate
