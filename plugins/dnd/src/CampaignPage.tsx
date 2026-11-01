import { useCallback, useEffect, useState, type MouseEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Modal, Spinner, TypeDot, api, embedNavigate, enc, fmtDate, qs, relTime, tr, useApp, useTypes, useVaultEvents } from '@basaltnotes/plugin-sdk/web'

interface Overview {
  campaign: { id: string | null; title: string; slug: string; status: string | null; system: string | null; players: any[]; dm: string | null }
  last_session: { id: string; title: string; number: number | null; date: string | null; recap_excerpt: string } | null
  sessions: { id: string; number: number | null; date: string | null; title: string }[]
  open_quests: { id: string; title: string; status: string; giver: string | null }[]
  characters: { id: string; title: string; player: string | null; class: string | null; status: string | null }[]
  recent_entities: { id: string; type: string; title: string; updated: string }[]
  counts: Record<string, number>
  scripts?: { id: string; title: string; planned_for: string | null; updated: string }[]
  open_proposals: number
}

export function CampaignPage() {
  const embedded = location.pathname.startsWith('/embed/')
  const { vault = '', campaign = '' } = useParams()
  const types = useTypes(vault)
  const { isAdmin, embed, features } = useApp()
  const params = new URLSearchParams(location.search)
  const [visibility, setVisibility] = useState<'dm' | 'players'>(params.get('visibility') === 'players' ? 'players' : 'dm')
  const [o, setO] = useState<Overview | null>(null)
  const [timeline, setTimeline] = useState<any[]>([])
  const [error, setError] = useState<string | null>(null)
  const [share, setShare] = useState<string | null>(null)

  const load = useCallback(() => {
    api<Overview>(`/vaults/${enc(vault)}/campaigns/${enc(campaign)}/overview${qs({ visibility })}`)
      .then((r) => {
        setO(r)
        setError(null)
        if (!embed) document.title = tr('{title} – BasaltNotes', { title: r.campaign.title })
      })
      .catch((e) => setError((e as Error).message))
    api<{ items: any[] }>(`/vaults/${enc(vault)}/campaigns/${enc(campaign)}/timeline${qs({ visibility })}`)
      .then((r) => setTimeline(r.items))
      .catch(() => setTimeline([]))
  }, [vault, campaign, visibility, embed])
  useEffect(load, [load])
  useVaultEvents(vault, (e) => {
    if (e.event.startsWith('note.') || e.event === 'inbox.processed' || e.event.startsWith('proposal.')) load()
  })

  const link = (id: string) => (embedded ? `/embed/${vault}/note/${enc(id)}${location.search}` : `/${vault}/note/${enc(id)}`)
  const onLink = (e: MouseEvent, id: string, title: string, type: string) => {
    if (embedNavigate(id, title, type)) e.preventDefault()
  }

  const createShare = async () => {
    if (!o) return
    const t = await api<{ token: string }>('/tokens', {
      body: { name: `Spieler-Link: ${o.campaign.title}`, vaults: [vault], scopes: ['read'], visibility: 'players', campaign: o.campaign.title, kind: 'share' },
    })
    setShare(`${location.origin}/embed/${vault}/campaign/${o.campaign.slug}?visibility=players&token=${encodeURIComponent(t.token)}`)
  }

  if (error) return <div className="page"><div className="banner danger">{error}</div></div>
  if (!o) return <div className="page"><Spinner /></div>

  return (
    <div className="page">
      <div className="page-header">
        <h1>
          <TypeDot type="campaign" /> {o.campaign.title}
        </h1>
        {o.campaign.system && <span className="chip">{o.campaign.system}</span>}
        {o.campaign.status && <span className="chip accent">{tr(o.campaign.status)}</span>}
        {params.get('visibility') !== 'players' && (
          <div className="tabs" role="tablist" aria-label={tr('Sicht')}>
            <button className={visibility === 'dm' ? 'active' : ''} onClick={() => setVisibility('dm')}>
              {tr('DM-Sicht')}
            </button>
            <button className={visibility === 'players' ? 'active' : ''} onClick={() => setVisibility('players')}>
              {tr('Spieler-Sicht')}
            </button>
          </div>
        )}
        {o.campaign.id && !embedded && (
          <Link className="btn small" to={link(o.campaign.id)}>
            {tr('Kampagnen-Notiz')}
          </Link>
        )}
        {isAdmin && !embedded && (
          <button className="btn small" onClick={createShare} title={tr('Nur-Lese-Link für Spielende')}>
            {tr('Spieler-Link …')}
          </button>
        )}
      </div>

      {!!o.open_proposals && !embedded && features.curator && (
        <Link to={`/${vault}/proposals?campaign=${enc(o.campaign.title)}`} className="banner">
          {tr('✦ {open_proposals} offene Vorschläge des Kurators für diese Kampagne', { open_proposals: o.open_proposals })}
        </Link>
      )}

      {o.last_session && (
        <section className="card" style={{ marginBottom: 16 }}>
          <div className="card-title">
            {tr('Was bisher geschah')}
            <span className="small muted" style={{ fontWeight: 400 }}>
              — <Link to={link(o.last_session.id)} onClick={(e) => onLink(e, o.last_session!.id, o.last_session!.title, 'session')}>{o.last_session.title}</Link>
            </span>
          </div>
          <div className="recap">{o.last_session.recap_excerpt || <span className="muted">{tr('Noch keine Zusammenfassung.')}</span>}</div>
        </section>
      )}

      <div className="row" style={{ marginBottom: 16 }}>
        <div className="stat">
          <b>{o.sessions.length}</b>
          <span>{tr('Sessions')}</span>
        </div>
        {Object.entries(o.counts)
          .sort((a, b) => b[1] - a[1])
          .map(([t, n]) => (
            <Link key={t} className="stat" style={{ color: 'inherit', textDecoration: 'none' }} to={embedded ? '#' : `/${vault}/search?type=${t}&campaign=${enc(o.campaign.title)}`}>
              <b>{n}</b>
              <span>{types.find((x) => x.name === t)?.label ?? t}</span>
            </Link>
          ))}
      </div>

      <div className="grid-2">
        <section className="card">
          <div className="card-title">{tr('Timeline')}</div>
          {timeline.length === 0 ? (
            <div className="empty small">{tr('Noch keine Sessions.')}</div>
          ) : (
            <div className="timeline">
              {[...timeline].reverse().map((s) => (
                <div key={s.id} className="timeline-item">
                  <Link to={link(s.id)} onClick={(e) => onLink(e, s.id, s.title, 'session')}>
                    <strong>{s.number ? `#${s.number} ` : ''}</strong>
                    {s.title}
                  </Link>
                  <div className="small faint">{fmtDate(s.date)}</div>
                  {s.recap_excerpt && <div className="small muted">{s.recap_excerpt}</div>}
                </div>
              ))}
            </div>
          )}
        </section>
        <div className="stack">
          {visibility === 'dm' && !!o.scripts?.length && (
            <section className="card">
              <div className="card-title">{tr('Vorbereitung (geplante Skripte)')}</div>
              <div className="list">
                {o.scripts.map((s) => (
                  <Link key={s.id} className="list-item" to={link(s.id)} onClick={(e) => onLink(e, s.id, s.title, 'script')}>
                    <TypeDot type="script" />
                    <span className="grow">{s.title}</span>
                    {s.planned_for && <span className="small faint">{fmtDate(s.planned_for)}</span>}
                  </Link>
                ))}
              </div>
            </section>
          )}
          <section className="card">
            <div className="card-title">{tr('Offene Quests')}</div>
            {o.open_quests.length === 0 ? (
              <div className="small faint">{tr('Keine offenen Quests.')}</div>
            ) : (
              <div className="list">
                {o.open_quests.map((q) => (
                  <Link key={q.id} className="list-item" to={link(q.id)} onClick={(e) => onLink(e, q.id, q.title, 'quest')}>
                    <TypeDot type="quest" />
                    <span className="grow">{q.title}</span>
                    {q.giver && <span className="small faint">{String(q.giver).replace(/^\[\[|\]\]$/g, '')}</span>}
                  </Link>
                ))}
              </div>
            )}
          </section>
          <section className="card">
            <div className="card-title">{tr('Charaktere')}</div>
            {o.characters.length === 0 ? (
              <div className="small faint">{tr('Noch keine Charaktere.')}</div>
            ) : (
              <div className="list">
                {o.characters.map((c) => (
                  <Link key={c.id} className="list-item" to={link(c.id)} onClick={(e) => onLink(e, c.id, c.title, 'character')}>
                    <TypeDot type="character" />
                    <span className="grow">{c.title}</span>
                    <span className="small faint">{[c.player, c.class].filter(Boolean).join(' · ')}</span>
                  </Link>
                ))}
              </div>
            )}
          </section>
          <section className="card">
            <div className="card-title">{tr('Zuletzt geändert')}</div>
            <div className="list">
              {o.recent_entities.map((r) => (
                <Link key={r.id} className="list-item" to={link(r.id)} onClick={(e) => onLink(e, r.id, r.title, r.type)}>
                  <TypeDot type={r.type} />
                  <span className="grow">{r.title}</span>
                  <span className="small faint">{relTime(r.updated)}</span>
                </Link>
              ))}
            </div>
          </section>
        </div>
      </div>
      {share && (
        <Modal title="Spieler-Link" onClose={() => setShare(null)} footer={<button className="btn primary" onClick={() => void navigator.clipboard.writeText(share)}>{tr('Kopieren')}</button>}>
          <div className="modal-body stack">
            <p className="small muted" style={{ margin: 0 }}>
              {tr('Nur-Lese-Link für die Spielenden. Zeigt nur Notizen und Bereiche mit')}{' '}<code>{tr('visibility: players')}</code> {tr('dieser Kampagne. Widerrufen unter Einstellungen → Tokens. Der Link wird nur einmal angezeigt.')}
            </p>
            <textarea className="input mono" readOnly value={share} rows={3} onFocus={(e) => e.target.select()} />
          </div>
        </Modal>
      )}
    </div>
  )
}
