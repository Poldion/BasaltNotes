import { Fragment, useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, enc, qs } from '../lib/api'
import { useApp, useVaultEvents } from '../lib/state'
import { DocumentUpload } from '../components/DocumentUpload'
import { Spinner, StatusChip, fmtDateTime, relTime } from '../lib/ui'
import { tr } from '../lib/i18n'
import { Icon } from '../components/Icon'

const FILTERS: [string, string][] = [
  ['', tr('Alle')],
  ['queued,running', tr('Offen')],
  ['processed,stored', tr('Verarbeitet')],
  ['error', tr('Fehler')],
  ['cancelled', tr('Abgebrochen')],
]

export function InboxPage() {
  const { vault = '' } = useParams()
  const { toast, canWrite } = useApp()
  const [items, setItems] = useState<any[] | null>(null)
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [detail, setDetail] = useState<any | null>(null)
  const [text, setText] = useState('')
  const [campaign, setCampaign] = useState('')
  const [curate, setCurate] = useState<'review' | 'auto' | 'none'>('review')
  const [campaigns, setCampaigns] = useState<string[]>([])

  const load = useCallback(() => {
    api<{ items: any[] }>(`/vaults/${enc(vault)}/inbox${qs({ status: filter, limit: 100 })}`)
      .then((r) => setItems(r.items))
      .catch(() => setItems([]))
  }, [vault, filter])
  useEffect(load, [load])
  useEffect(() => {
    api<{ items: { title: string }[] }>(`/vaults/${enc(vault)}/campaigns`)
      .then((r) => {
        setCampaigns(r.items.map((c) => c.title))
        if (r.items.length === 1) setCampaign(r.items[0].title)
      })
      .catch(() => undefined)
  }, [vault])
  useVaultEvents(vault, (e) => {
    if (e.event.startsWith('inbox.')) {
      load()
      if (e.event === 'inbox.processed') toast(tr('Eingang verarbeitet: {x} neu, {x2} ergänzt, {x3} Vorschläge', { x: e.data.created ?? 0, x2: e.data.updated ?? 0, x3: e.data.proposals ?? 0 }), 'success')
      if (e.event === 'inbox.failed') toast(tr('Eingang fehlgeschlagen: {error}', { error: e.data.error }), 'error')
    }
  })

  useEffect(() => {
    if (!open) return setDetail(null)
    api(`/vaults/${enc(vault)}/inbox/${enc(open)}`)
      .then(setDetail)
      .catch(() => setDetail(null))
  }, [open, vault, items])

  const submit = async () => {
    if (!text.trim()) return
    try {
      await api(`/vaults/${enc(vault)}/inbox`, { body: { text, campaign: campaign || undefined, curate, source: { app: 'basaltnotes' } } })
      setText('')
      toast(tr('Eingeliefert'), 'success')
      load()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const act = async (path: string, method = 'POST', body?: any) => {
    try {
      await api(path, { method, body })
      load()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>{tr('Eingang')}</h1>
        <div className="tabs">
          {FILTERS.map(([v, l]) => (
            <button key={v} className={filter === v ? 'active' : ''} onClick={() => setFilter(v)}>
              {l}
            </button>
          ))}
        </div>
      </div>

      {canWrite && <DocumentUpload key={campaigns.join('|')} vault={vault} campaigns={campaigns} onUploaded={load} />}
      {canWrite && (
        <section className="card stack" style={{ marginBottom: 18 }}>
          <div className="card-title" style={{ marginBottom: 0 }}>
            {tr('Schnellnotiz einliefern')}
          </div>
          <textarea className="input" placeholder={tr('z. B. „Die Gruppe hat den Schlüssel an den Händler verkauft.“')} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && submit()} />
          <div className="row">
            {campaigns.length > 0 && (
              <select className="input" style={{ width: 'auto' }} value={campaign} onChange={(e) => setCampaign(e.target.value)} aria-label={tr('Kampagne')}>
                <option value="">{tr('Ohne Kampagne')}</option>
                {campaigns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
            <select className="input" style={{ width: 'auto' }} value={curate} onChange={(e) => setCurate(e.target.value as any)} aria-label={tr('Kurator')}>
              <option value="review">{tr('Kurator: alles als Vorschlag')}</option>
              <option value="auto">{tr('Kurator: nach Regeln')}</option>
              <option value="none">{tr('Nur ablegen')}</option>
            </select>
            <span className="grow" />
            <button className="btn primary" onClick={submit} disabled={!text.trim()}>
              {tr('Einliefern')}
            </button>
          </div>
        </section>
      )}

      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <div className="empty">{tr('Keine Einträge.')}</div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{tr('Status')}</th>
                  <th>{tr('Eintrag')}</th>
                  <th>{tr('Quelle')}</th>
                  <th>{tr('Ergebnis')}</th>
                  <th>{tr('Eingang')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <Fragment key={i.id}>
                    <tr onClick={() => setOpen(open === i.id ? null : i.id)} style={{ cursor: 'pointer' }}>
                      <td>
                        <StatusChip status={i.status} /> {i.status === 'running' && <Spinner />}
                      </td>
                      <td>
                        {i.note_id ? (
                          <Link to={`/${vault}/note/${enc(i.note_id)}`} onClick={(e) => e.stopPropagation()}>
                            {i.title}
                          </Link>
                        ) : (
                          i.title
                        )}
                        {i.campaign && <div className="small faint">{i.campaign}</div>}
                      </td>
                      <td className="small muted">{i.source?.app === 'upload' ? (
                          <span className="icon-inline">
                            <Icon name="file" /> {tr('Upload')}
                          </span>
                        ) : (
                          (i.source?.app ?? '–')
                        )}</td>
                      <td className="small">
                        {i.result ? tr('{created} neu · {updated} ergänzt · {proposals} Vorschläge', { created: i.result.created, updated: i.result.updated, proposals: i.result.proposals }) : i.error ? <span style={{ color: 'var(--danger)' }}>{i.error}</span> : '–'}
                      </td>
                      <td className="small faint" title={fmtDateTime(i.created)}>
                        {relTime(i.created)}
                      </td>
                      <td onClick={(e) => e.stopPropagation()} className="row" style={{ flexWrap: 'nowrap' }}>
                        {canWrite && ['queued', 'running'].includes(i.status) && (
                          <button className="btn small danger" onClick={() => act(`/vaults/${enc(vault)}/inbox/${enc(i.id)}/cancel`)} title={tr('Verarbeitung abbrechen')}>
                            <Icon name="stop" />
                          </button>
                        )}
                        {canWrite && i.status !== 'running' && (
                          <button className="btn small" onClick={() => act(`/vaults/${enc(vault)}/inbox/${enc(i.id)}/reprocess`)} title={tr('Erneut verarbeiten (ersetzt Beiträge derselben Quelle)')}>
                            <Icon name="refresh" />
                          </button>
                        )}
                        {canWrite && !['discarded', 'running'].includes(i.status) && (
                          <button className="btn small ghost" onClick={() => act(`/vaults/${enc(vault)}/inbox/${enc(i.id)}`, 'DELETE')} title={tr('Verwerfen')}>
                            ✕
                          </button>
                        )}
                      </td>
                    </tr>
                    {open === i.id && (
                      <tr>
                        <td colSpan={6} style={{ background: 'var(--surface-2)' }}>
                          {!detail ? (
                            <Spinner />
                          ) : (
                            <div className="stack small">
                              <div>
                                {tr('Quelle:')}{' '}<code>{detail.source_key}</code> {tr('· Modus:')}{' '}{detail.curate}
                                {detail.run_id && (
                                  <>
                                    {' '}
                                    · <Link to={`/${vault}/runs/${enc(detail.run_id)}`}>{tr('Kurator-Lauf ansehen')}</Link>
                                  </>
                                )}
                              </div>
                              {detail.proposals?.length > 0 && (
                                <div>
                                  {tr('Vorschläge:')}{' '}
                                  {detail.proposals.map((p: any) => (
                                    <span key={p.id} className="chip" style={{ marginRight: 4 }}>
                                      {p.title} ({p.status})
                                    </span>
                                  ))}
                                </div>
                              )}
                              {(detail.payload?.text || detail.payload?.note?.body) && (
                                <pre className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto', margin: 0 }}>
                                  {detail.payload.text ?? detail.payload.note.body}
                                </pre>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
