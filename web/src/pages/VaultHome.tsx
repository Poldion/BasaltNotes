import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, enc, type NoteSummary } from '../lib/api'
import { typeLabel, useApp, useTypes, useVaultEvents } from '../lib/state'
import { Spinner, StatusChip, TypeDot, relTime, slugify } from '../lib/ui'
import { DocumentUpload } from '../components/DocumentUpload'
import { registry } from '../lib/plugins'
import { tr } from '../lib/i18n'

export function VaultHome() {
  const { vault = '' } = useParams()
  const { vaults, isPlayer, canWrite, features, isAreaLimited } = useApp()
  const types = useTypes(vault)
  const info = vaults.find((v) => v.id === vault)
  const [recent, setRecent] = useState<NoteSummary[] | null>(null)
  const [campaigns, setCampaigns] = useState<{ title: string }[]>([])
  const [inbox, setInbox] = useState<any[]>([])

  const load = useCallback(() => {
    api<{ items: NoteSummary[] }>(`/vaults/${enc(vault)}/notes?limit=15&sort=-updated&fields=title,type,path,updated,campaign`)
      .then((r) => setRecent(r.items))
      .catch(() => setRecent([]))
    api<{ items: { title: string }[] }>(`/vaults/${enc(vault)}/campaigns`)
      .then((r) => setCampaigns(r.items))
      .catch(() => setCampaigns([]))
    if (!isPlayer)
      api<{ items: any[] }>(`/vaults/${enc(vault)}/inbox?limit=5`)
        .then((r) => setInbox(r.items))
        .catch(() => setInbox([]))
  }, [vault, isPlayer])
  useEffect(() => {
    load()
    document.title = tr('{x} – BasaltNotes', { x: info?.name ?? vault })
  }, [load, info?.name, vault])
  useVaultEvents(vault, (e) => {
    if (e.event.startsWith('note.') || e.event.startsWith('inbox.')) load()
  })

  return (
    <div className="page">
      <div className="page-header">
        <h1>{info?.name ?? vault}</h1>
        <span className="chip">{tr('{x} Notizen', { x: info?.note_count ?? 0 })}</span>
        {features.curator && info?.curator.enabled && <span className="chip accent">{tr('Kurator aktiv')}</span>}
      </div>

      {registry.home.map((h) => (
        <h.component key={`${h.plugin}:${h.id}`} vault={vault} />
      ))}

      <div className="grid-2">
        <section className="card">
          <div className="card-title">{tr('Zuletzt geändert')}</div>
          {recent === null ? (
            <Spinner />
          ) : recent.length === 0 ? (
            <div className="empty small">{canWrite ? <>{tr('Noch keine Notizen. Lege mit')}{' '}<kbd>{tr('Alt')}</kbd>+<kbd>N</kbd> {tr('die erste an.')}</> : tr('Noch keine Notizen für dich freigegeben.')}</div>
          ) : (
            <div className="list">
              {recent.map((n) => (
                <Link key={n.id} className="list-item" to={`/${vault}/note/${enc(n.id)}`}>
                  <TypeDot type={n.type} />
                  <span className="grow">{n.title}</span>
                  <span className="small faint">{typeLabel(types, n.type)}</span>
                  <span className="small faint" style={{ minWidth: 90, textAlign: 'right' }}>
                    {relTime(n.updated)}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </section>
        {!isPlayer && !features.curator && canWrite && !isAreaLimited && (
          <section className="card">
            <DocumentUpload vault={vault} campaigns={campaigns.map((c) => c.title)} onUploaded={load} />
          </section>
        )}
        {!isPlayer && features.curator && !isAreaLimited && (
        <section className="card">
          <div className="card-title">
            {tr('Eingang')}{' '}<Link className="small" to={`/${vault}/inbox`} style={{ marginLeft: 'auto' }}>{tr('alle →')}</Link>
          </div>
          {inbox.length === 0 ? (
            <div className="empty small">{tr('Keine Einträge. WhisperNotes und das DM-Panel liefern hierher.')}</div>
          ) : (
            <div className="list">
              {inbox.map((i) => (
                <div key={i.id} className="list-item">
                  <StatusChip status={i.status} />
                  <span className="grow">{i.title ?? i.source_key}</span>
                  <span className="small faint">{relTime(i.created)}</span>
                </div>
              ))}
            </div>
          )}
          {!!info?.open_proposals && (
            <Link to={`/${vault}/proposals`} className="banner" style={{ marginTop: 12, marginBottom: 0 }}>
              {tr('✦ {open_proposals} offene(r) Vorschlag/Vorschläge des Kurators prüfen', { open_proposals: info.open_proposals })}
            </Link>
          )}
        </section>
        )}
      </div>
    </div>
  )
}
