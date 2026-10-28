import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { api, enc, qs } from '../lib/api'
import { typeLabel, useTypes } from '../lib/state'
import { Spinner, TypeDot, relTime, useDebounced } from '../lib/ui'
import { tr } from '../lib/i18n'

interface Hit {
  id: string
  title: string
  type: string
  path: string
  campaign: string | null
  updated: string | null
  highlights: string[]
  aliases: string[]
}

export function SearchPage({ embedded }: { embedded?: boolean } = {}) {
  const { vault = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const types = useTypes(vault)
  const [q, setQ] = useState(params.get('q') ?? '')
  const [type, setType] = useState(params.get('type') ?? '')
  const [campaign, setCampaign] = useState(params.get('campaign') ?? '')
  const [tag, setTag] = useState(params.get('tag') ?? '')
  const [prop, setProp] = useState({ field: '', value: '' })
  const [campaigns, setCampaigns] = useState<string[]>([])
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([])
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const dq = useDebounced(q, 250)

  useEffect(() => {
    api<{ items: { title: string }[] }>(`/vaults/${enc(vault)}/campaigns`)
      .then((r) => setCampaigns(r.items.map((c) => c.title)))
      .catch(() => undefined)
    api<{ items: { tag: string; count: number }[] }>(`/vaults/${enc(vault)}/tags`)
      .then((r) => setTags(r.items))
      .catch(() => undefined)
  }, [vault])

  const run = async (more = false) => {
    setLoading(true)
    try {
      const where = prop.field && prop.value ? [{ field: prop.field, op: 'contains', value: prop.value }] : undefined
      const visibility = params.get('visibility') ?? undefined
      let r: { items: Hit[]; next_cursor: string | null }
      if (dq.trim()) {
        r = await api(`/vaults/${enc(vault)}/search${qs({ q: dq, type, campaign, tag, cursor: more ? cursor : undefined, visibility })}`)
      } else {
        const res = await api<any>(`/vaults/${enc(vault)}/query${qs({ visibility })}`, {
          body: {
            where: [
              ...(type ? [{ field: 'type', op: '=', value: type }] : []),
              ...(campaign ? [{ field: 'campaign', op: '=', value: campaign }] : []),
              ...(tag ? [{ field: 'tag', op: '=', value: tag }] : []),
              ...(where ?? []),
            ],
            sort: [{ field: 'updated', dir: 'desc' }],
            limit: 50,
            cursor: more ? cursor : undefined,
          },
        })
        r = { items: res.items.map((i: any) => ({ ...i, highlights: [] })), next_cursor: res.next_cursor }
      }
      setHits((h) => (more && h ? [...h, ...r.items] : r.items))
      setCursor(r.next_cursor)
    } catch {
      setHits([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!embedded) setParams(Object.fromEntries(Object.entries({ q: dq, type, campaign, tag }).filter(([, v]) => v)) as any, { replace: true })
    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq, type, campaign, tag, prop.field, prop.value, vault])

  const link = (id: string) => (embedded ? `/embed/${vault}/note/${enc(id)}${location.search}` : `/${vault}/note/${enc(id)}`)

  return (
    <div className="page">
      {!embedded && (
        <div className="page-header">
          <h1>{tr('Suche')}</h1>
        </div>
      )}
      <div className="stack">
        <input className="input" style={{ fontSize: 17, padding: '10px 14px' }} autoFocus placeholder={tr('Volltext, Titel, Aliasse …')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={tr('Suchbegriff')} />
        <div className="row">
          <select className="input" style={{ width: 'auto' }} value={type} onChange={(e) => setType(e.target.value)} aria-label={tr('Typ')}>
            <option value="">{tr('Alle Typen')}</option>
            {types.map((t) => (
              <option key={t.name} value={t.name}>
                {t.label}
              </option>
            ))}
          </select>
          {campaigns.length > 0 && (
            <select className="input" style={{ width: 'auto' }} value={campaign} onChange={(e) => setCampaign(e.target.value)} aria-label={tr('Kampagne')}>
              <option value="">{tr('Alle Kampagnen')}</option>
              {campaigns.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
          {tags.length > 0 && (
            <select className="input" style={{ width: 'auto' }} value={tag} onChange={(e) => setTag(e.target.value)} aria-label={tr('Tag')}>
              <option value="">{tr('Alle Tags')}</option>
              {tags.map((t) => (
                <option key={t.tag} value={t.tag}>
                  #{t.tag} ({t.count})
                </option>
              ))}
            </select>
          )}
          {!dq.trim() && (
            <>
              <input className="input" style={{ width: 140 }} placeholder={tr('Eigenschaft')} value={prop.field} onChange={(e) => setProp({ ...prop, field: e.target.value.trim() })} aria-label={tr('Eigenschaft')} />
              <input className="input" style={{ width: 160 }} placeholder={tr('enthält …')} value={prop.value} onChange={(e) => setProp({ ...prop, value: e.target.value })} aria-label={tr('Wert')} />
            </>
          )}
          {loading && <Spinner />}
        </div>
      </div>
      <div className="list" style={{ marginTop: 16 }}>
        {hits?.length === 0 && <div className="empty">{tr('Keine Treffer.')}</div>}
        {hits?.map((h) => (
          <Link key={h.id} to={link(h.id)} className="list-item" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 2 }}>
            <span className="row" style={{ gap: 8, width: '100%' }}>
              <TypeDot type={h.type} />
              <strong>{h.title}</strong>
              <span className="chip">{typeLabel(types, h.type)}</span>
              {h.campaign && <span className="small faint">{h.campaign}</span>}
              <span className="grow" />
              <span className="small faint">{relTime(h.updated)}</span>
            </span>
            {h.highlights?.map((s, i) => (
              // Ausschnitte enthalten nur <mark> vom Server; restlicher Text wird maskiert
              <span key={i} className="small muted" dangerouslySetInnerHTML={{ __html: escapeExceptMark(s) }} />
            ))}
          </Link>
        ))}
      </div>
      {cursor && (
        <button className="btn" style={{ marginTop: 12 }} onClick={() => run(true)}>
          {tr('Mehr laden')}
        </button>
      )}
    </div>
  )
}

function escapeExceptMark(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/&lt;mark&gt;/g, '<mark>')
    .replace(/&lt;\/mark&gt;/g, '</mark>')
}
