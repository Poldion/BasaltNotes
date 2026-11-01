import { useCallback, useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { api, enc, qs } from '../lib/api'
import { useApp, useVaultEvents } from '../lib/state'
import { Confidence, DiffView, Modal, OP_LABELS, Spinner, StatusChip, relTime } from '../lib/ui'
import { tr } from '../lib/i18n'

interface Proposal {
  id: string
  run_id: string
  campaign: string | null
  note_id: string | null
  kind: string
  title: string
  reason: string | null
  confidence: number
  status: string
  created: string
  operation: any
  diff?: string
}

export function ProposalsPage({ embedded }: { embedded?: boolean } = {}) {
  const { vault = '' } = useParams()
  const [params] = useSearchParams()
  const { toast, canCurate } = useApp()
  const [status, setStatus] = useState('open')
  const [items, setItems] = useState<Proposal[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<Proposal | null>(null)
  const campaign = params.get('campaign') ?? undefined
  const [scanning, setScanning] = useState(false)

  /** Duplikate ohne LLM suchen und als Zusammenführ-Vorschläge anlegen */
  const scan = async () => {
    setScanning(true)
    try {
      const r = await api<{ found: number; known: number; created: number }>(`/vaults/${enc(vault)}/curator/duplicates`, { method: 'POST' })
      toast(
        r.created
          ? tr('{created} mögliche Duplikate gefunden – als Vorschläge angelegt.', { created: r.created })
          : r.found
            ? tr('Keine neuen Duplikate (bekannte Paare wurden schon vorgeschlagen oder abgelehnt).')
            : tr('Keine Duplikate gefunden.'),
        'success',
      )
      setStatus('open')
      load()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setScanning(false)
    }
  }

  const load = useCallback(() => {
    api<{ items: Proposal[] }>(`/vaults/${enc(vault)}/proposals${qs({ status, campaign, diff: 1, limit: 200 })}`)
      .then((r) => {
        setItems(r.items)
        setSelected(new Set())
      })
      .catch(() => setItems([]))
  }, [vault, status, campaign])
  useEffect(load, [load])
  useVaultEvents(vault, (e) => {
    if (e.event.startsWith('proposal.') || e.event === 'run.reverted' || e.event === 'inbox.processed') load()
  })

  const resolve = async (ids: string[], action: 'accept' | 'reject') => {
    try {
      if (ids.length === 1) await api(`/vaults/${enc(vault)}/proposals/${enc(ids[0])}/${action}`, { method: 'POST' })
      else {
        const r = await api<{ results: any[] }>(`/vaults/${enc(vault)}/proposals/bulk`, { body: { ids, action } })
        const failed = r.results.filter((x) => x.error)
        if (failed.length) toast(tr('{length} Vorschlag/Vorschläge fehlgeschlagen: {error}', { length: failed.length, error: failed[0].error }), 'error')
      }
      toast(action === 'accept' ? `${ids.length} angenommen` : `${ids.length} abgelehnt`, 'success')
      load()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const toggle = (set: Set<string>, id: string) => {
    const n = new Set(set)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    return n
  }

  const open = items?.filter((p) => p.status === 'open') ?? []
  const noteLink = (id: string) => (embedded ? `/embed/${vault}/note/${enc(id)}${location.search}` : `/${vault}/note/${enc(id)}`)

  return (
    <div className="page">
      <div className="page-header">
        <h1>{tr('Vorschläge des Kurators')}</h1>
        {campaign && <span className="chip accent">{campaign}</span>}
        {canCurate && !embedded && (
          <button className="btn small" onClick={scan} disabled={scanning} title={tr('Vault nach doppelten Einträgen durchsuchen (ohne LLM, dauert Sekunden)')}>
            {scanning ? <Spinner /> : '⧉'} {tr('Duplikate suchen')}
          </button>
        )}
        <div className="tabs">
          {[
            ['open', tr('Offen')],
            ['accepted', tr('Angenommen')],
            ['rejected', tr('Abgelehnt')],
            ['all', tr('Alle')],
          ].map(([v, l]) => (
            <button key={v} className={status === v ? 'active' : ''} onClick={() => setStatus(v)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      {canCurate && status === 'open' && open.length > 0 && (
        <div className="row" style={{ marginBottom: 12 }}>
          <label className="row small">
            <input type="checkbox" checked={selected.size === open.length && open.length > 0} onChange={(e) => setSelected(e.target.checked ? new Set(open.map((p) => p.id)) : new Set())} />
            {tr('Alle auswählen')}
          </label>
          <span className="grow" />
          <button className="btn small primary" disabled={!selected.size} onClick={() => resolve([...selected], 'accept')}>
            {tr('{x} Annehmen', { x: selected.size || '' })}
          </button>
          <button className="btn small" disabled={!selected.size} onClick={() => resolve([...selected], 'reject')}>
            {tr('{x} Ablehnen', { x: selected.size || '' })}
          </button>
        </div>
      )}
      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <div className="empty">{status === 'open' ? tr('Keine offenen Vorschläge – alles einsortiert.') : tr('Keine Einträge.')}</div>
      ) : (
        <div className="stack">
          {items.map((p) => {
            const op = p.operation
            return (
              <article key={p.id} className="card proposal">
                <div>{p.status === 'open' && canCurate && <input type="checkbox" aria-label={tr('Auswählen')} checked={selected.has(p.id)} onChange={() => setSelected(toggle(selected, p.id))} />}</div>
                <div className="stack" style={{ gap: 6 }}>
                  <div className="row">
                    <span className={`chip ${p.kind === 'contradiction' || p.kind === 'merge_entities' ? 'danger' : 'accent'}`}>{OP_LABELS[p.kind] ?? p.kind}</span>
                    <strong>{p.title}</strong>
                    {p.status !== 'open' && <StatusChip status={p.status} />}
                    <span className="grow" />
                    <Confidence value={p.confidence} />
                  </div>
                  {p.reason && <div className="small muted">{p.reason}</div>}
                  <div className="row small faint">
                    {p.note_id && <Link to={noteLink(p.note_id)}>{tr('Notiz öffnen')}</Link>}
                    {op.other_id && <Link to={noteLink(op.other_id)}>{tr('{other_title} öffnen', { other_title: op.other_title })}</Link>}
                    {!embedded && (
                      <Link to={`/${vault}/runs/${enc(p.run_id)}`}>{tr('Lauf')}</Link>
                    )}
                    <span>{relTime(p.created)}</span>
                    {p.diff && (
                      <button className="btn small ghost" onClick={() => setExpanded(toggle(expanded, p.id))}>
                        {expanded.has(p.id) ? tr('Diff ausblenden') : tr('Diff anzeigen')}
                      </button>
                    )}
                  </div>
                  {p.diff && expanded.has(p.id) && <DiffView diff={p.diff} />}
                  {p.status === 'open' && canCurate && (
                    <div className="row">
                      <button className="btn small primary" onClick={() => resolve([p.id], 'accept')}>
                        {tr('Annehmen')}
                      </button>
                      <button className="btn small" onClick={() => setEditing(p)}>
                        {tr('Bearbeiten')}
                      </button>
                      <button className="btn small ghost" onClick={() => resolve([p.id], 'reject')}>
                        {tr('Ablehnen')}
                      </button>
                    </div>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}
      {editing && <EditProposal vault={vault} p={editing} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), load())} />}
    </div>
  )
}

function EditProposal({ vault, p, onClose, onSaved }: { vault: string; p: Proposal; onClose: () => void; onSaved: () => void }) {
  const op = p.operation
  const { toast } = useApp()
  const [to, setTo] = useState(op.to ?? '')
  const [title, setTitle] = useState(op.title ?? '')
  const [alias, setAlias] = useState(op.alias ?? '')
  const [content, setContent] = useState(op.block?.content ?? '')
  const [diff, setDiff] = useState(p.diff ?? '')

  const save = async (accept: boolean) => {
    const changes: any = {}
    if ('to' in op) changes.to = to
    if (op.op === 'create_entity') changes.title = title
    if (op.op === 'add_alias') changes.alias = alias
    if (op.block) changes.block = { content }
    try {
      const r = await api<Proposal>(`/vaults/${enc(vault)}/proposals/${enc(p.id)}`, { method: 'PATCH', body: changes })
      setDiff(r.diff ?? '')
      if (accept) {
        await api(`/vaults/${enc(vault)}/proposals/${enc(p.id)}/accept`, { method: 'POST' })
        toast(tr('Angenommen'), 'success')
      }
      onSaved()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  return (
    <Modal
      title={tr('Vorschlag bearbeiten: {title}', { title: p.title })}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {tr('Abbrechen')}
          </button>
          <button className="btn" onClick={() => save(false)}>
            {tr('Speichern')}
          </button>
          <button className="btn primary" onClick={() => save(true)}>
            {tr('Speichern & annehmen')}
          </button>
        </>
      }
    >
      <div className="modal-body stack">
        {op.op === 'create_entity' && (
          <label className="field">
            <span>{tr('Titel')}</span>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
        )}
        {op.op === 'add_alias' && (
          <label className="field">
            <span>{tr('Alias')}</span>
            <input className="input" value={alias} onChange={(e) => setAlias(e.target.value)} />
          </label>
        )}
        {'to' in op && (
          <label className="field">
            <span>
              {tr('Neuer Wert für „{field}“ (bisher: {x})', { field: op.field, x: String(op.from ?? '–') })}
            </span>
            <input className="input" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        )}
        {op.block && (
          <label className="field">
            <span>{tr('Inhalt des Bereichs')}</span>
            <textarea className="input mono" rows={6} value={content} onChange={(e) => setContent(e.target.value)} />
          </label>
        )}
        {diff && <DiffView diff={diff} />}
      </div>
    </Modal>
  )
}
