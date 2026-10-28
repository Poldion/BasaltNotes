import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, enc } from '../lib/api'
import { useApp, useVaultEvents } from '../lib/state'
import { Confidence, OP_LABELS, Spinner, StatusChip, fmtDateTime, relTime, useConfirm } from '../lib/ui'
import { tr } from '../lib/i18n'
import { Icon } from '../components/Icon'

export function RunsPage() {
  const { vault = '', runId } = useParams()
  const navigate = useNavigate()
  const [items, setItems] = useState<any[] | null>(null)
  const load = useCallback(() => {
    api<{ items: any[] }>(`/vaults/${enc(vault)}/runs?limit=100`)
      .then((r) => setItems(r.items))
      .catch(() => setItems([]))
  }, [vault])
  useEffect(load, [load])
  useVaultEvents(vault, (e) => {
    if (e.event.startsWith('inbox.') || e.event === 'run.reverted') load()
  })

  if (runId) return <RunDetail vault={vault} runId={runId} onBack={() => navigate(`/${vault}/runs`)} onChanged={load} />

  return (
    <div className="page">
      <div className="page-header">
        <h1>{tr('Kurator-Protokoll')}</h1>
      </div>
      <p className="muted small" style={{ marginTop: -8 }}>
        {tr('Was wurde wann aus welcher Quelle geändert. Jeder Lauf ist ein eigener git-Commit und lässt sich rückgängig machen.')}
      </p>
      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <div className="empty">{tr('Noch keine Kurator-Läufe.')}</div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{tr('Zeit')}</th>
                  <th>{tr('Quelle')}</th>
                  <th>{tr('Status')}</th>
                  <th>{tr('Ergebnis')}</th>
                  <th>{tr('Modell')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/${vault}/runs/${enc(r.id)}`)}>
                    <td className="small" title={fmtDateTime(r.created)}>
                      {relTime(r.created)}
                    </td>
                    <td>
                      <div>{r.note_title ?? r.source_key}</div>
                      <div className="small faint mono">{r.source_key}</div>
                    </td>
                    <td>
                      <StatusChip status={r.reverted ? 'reverted' : r.dry_run ? 'planned' : r.status} />
                    </td>
                    <td className="small">
                      {r.error ? (
                        <span style={{ color: 'var(--danger)' }}>{r.error}</span>
                      ) : (
                        <>
                          {r.created_count} {tr('neu ·')}{' '}{r.applied_count} {tr('Änderungen ·')}{' '}{r.proposals} {tr('Vorschläge')}
                          {r.open_proposals > 0 && <span className="chip warn" style={{ marginLeft: 6 }}>{r.open_proposals} {tr('offen')}</span>}
                        </>
                      )}
                    </td>
                    <td className="small faint">{r.llm ? tr('{x} · {context} Tok.', { x: r.llm.model ?? '?', context: r.llm.context }) : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function RunDetail({ vault, runId, onBack, onChanged }: { vault: string; runId: string; onBack: () => void; onChanged: () => void }) {
  const [run, setRun] = useState<any | null>(null)
  const { toast, me } = useApp()
  const { confirm, el } = useConfirm()
  const canCurate = !!me?.scopes.some((s) => ['curate', 'admin'].includes(s))
  const [progress, setProgress] = useState<any | null>(null)
  const [now, setNow] = useState(Date.now())
  const load = useCallback(() => {
    api<any>(`/vaults/${enc(vault)}/runs/${enc(runId)}`)
      .then((r) => {
        setRun(r)
        if (r.status !== 'running') setProgress(null)
      })
      .catch((e) => toast((e as Error).message, 'error'))
  }, [vault, runId, toast])
  useEffect(load, [load])
  const running = run?.status === 'running'

  // Läuft der Lauf noch: Fortschritt live nachladen
  useEffect(() => {
    if (!running) return
    const poll = () => {
      api<{ running: any[] }>(`/vaults/${enc(vault)}/curator/status`)
        .then((st) => {
          const p = st.running.find((x) => x.run_id === runId)
          setProgress(p ?? null)
          if (!p) load()
        })
        .catch(() => undefined)
    }
    poll()
    const t = setInterval(poll, 2500)
    const clock = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      clearInterval(t)
      clearInterval(clock)
    }
  }, [running, vault, runId, load])

  const stop = async () => {
    try {
      if (run?.inbox_id) await api(`/vaults/${enc(vault)}/inbox/${enc(run.inbox_id)}/cancel`, { method: 'POST' })
      else await api(`/vaults/${enc(vault)}/curator/stop`, { method: 'POST' })
      toast(tr('Kurator wird gestoppt …'))
      setTimeout(load, 800)
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const revert = async () => {
    if (!(await confirm(<>{tr('Alle automatischen Änderungen dieses Laufs zurücknehmen und offene Vorschläge verwerfen?')}</>, { yes: tr('Rückgängig machen'), danger: true }))) return
    try {
      const r = await api<any>(`/vaults/${enc(vault)}/runs/${enc(runId)}/revert`, { method: 'POST' })
      toast(r.method === 'semantic' ? tr('Lauf zurückgenommen (spätere eigene Änderungen blieben erhalten).') : tr('Lauf rückgängig gemacht.'), 'success')
      load()
      onChanged()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  if (!run) return <div className="page"><Spinner /></div>
  const ex = run.extraction
  return (
    <div className="page">
      <div className="page-header">
        <button className="btn small ghost" onClick={onBack}>
          {tr('← Protokoll')}
        </button>
        <h1>{tr('Kurator-Lauf')}</h1>
        <StatusChip status={run.reverted ? 'reverted' : run.dry_run ? 'planned' : run.status} />
        {canCurate && !run.reverted && !run.dry_run && run.status === 'done' && (
          <button className="btn danger small" onClick={revert}>
            {tr('Lauf rückgängig machen')}
          </button>
        )}
      </div>
      <div className="card stack small" style={{ marginBottom: 16 }}>
        <div>
          {tr('Quelle:')}{' '}<code>{run.source_key}</code>
          {run.note_id && (
            <>
              {' '}
              · <Link to={`/${vault}/note/${enc(run.note_id)}`}>{tr('Quellnotiz')}</Link>
            </>
          )}
        </div>
        <div>
          {tr('Zeit:')}{' '}{fmtDateTime(run.created)} {tr('· Modus:')}{' '}{run.mode === 'review' ? tr('alles als Vorschlag') : tr('nach Regeln')}
          {run.campaign && <>{' '}{tr('· Kampagne: {campaign}', { campaign: run.campaign })}</>}
        </div>
        {run.llm && (
          <div>
            {tr('Modell: {model} · Kontext {context} Tokens · {chunks} Abschnitt(e)', { model: run.llm.model, context: run.llm.context, chunks: run.llm.chunks })}
          </div>
        )}
        {run.commit_sha && (
          <div>
            {tr('git-Commit:')}{' '}<code>{run.commit_sha.slice(0, 10)}</code>
          </div>
        )}
        {run.error && <div className="banner danger">{run.error}</div>}
        {run.llm?.warnings?.length > 0 && (
          <div className="banner">
            <div>
              {run.llm.warnings.map((w: string, i: number) => (
                <div key={i}>{w}</div>
              ))}
            </div>
          </div>
        )}
      </div>

      {running && <LiveProgress progress={progress} started={run.created} now={now} canStop={canCurate} onStop={stop} />}

      {ex?.resolutions?.length > 0 && (
        <section className="card" style={{ marginBottom: 16 }}>
          <div className="card-title">{tr('Erkannte Entitäten & Abgleich')}</div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{tr('Erkannt')}</th>
                  <th>{tr('Typ')}</th>
                  <th>{tr('Zuordnung')}</th>
                  <th>{tr('Methode')}</th>
                  <th>{tr('Sicherheit')}</th>
                </tr>
              </thead>
              <tbody>
                {ex.resolutions.map((r: any, i: number) => (
                  <tr key={i}>
                    <td>
                      {r.name}
                      {ex.entities?.[i]?.mentioned_as?.length > 0 && <div className="small faint">als: {ex.entities[i].mentioned_as.join(', ')}</div>}
                    </td>
                    <td className="small">{r.type}</td>
                    <td>{r.match === 'new' ? <span className="chip accent">{tr('neu')}</span> : <Link to={`/${vault}/note/${enc(r.match)}`}>{r.title}</Link>}</td>
                    <td className="small muted">
                      {{ exact: 'exakt', similar: tr('Ähnlichkeit'), llm: 'LLM', new: '–' }[r.method as string] ?? r.method}
                      {r.reason && <div className="faint">{r.reason}</div>}
                    </td>
                    <td>
                      <Confidence value={r.confidence} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {!running && (
      <section className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">{tr('Plan ({length} {x})', { length: run.plan.length, x: run.plan.length === 1 ? tr('Operation') : tr('Operationen') })}</div>
        <div className="list">
          {run.plan.map((op: any, i: number) => (
            <div key={i} className="list-item small">
              <span className={`chip ${op.auto ? 'ok' : 'warn'}`}>{op.auto ? 'auto' : tr('Vorschlag')}</span>
              <strong>{OP_LABELS[op.op] ?? op.op}</strong>
              <span className="grow">
                {op.title ?? op.note_title}
                {op.alias && tr(' → Alias „{alias}“', { alias: op.alias })}
                {op.field && ` · ${op.field}: ${String(op.from ?? '–')} → ${String(op.to)}`}
              </span>
              <Confidence value={op.confidence} />
            </div>
          ))}
        </div>
      </section>
      )}

      {run.applied?.length > 0 && (
        <section className="card" style={{ marginBottom: 16 }}>
          <div className="card-title">{tr('Angewendet')}</div>
          <div className="list">
            {run.applied.map((a: any, i: number) => (
              <div key={i} className="list-item small">
                <span className={`chip ${a.error ? 'danger' : 'ok'}`}>{OP_LABELS[a.op] ?? a.op}</span>
                <span className="grow">{a.note_id ? <Link to={`/${vault}/note/${enc(a.note_id)}`}>{a.title ?? a.note_id}</Link> : a.title}</span>
                <span className="faint">{a.error ?? a.result}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {run.proposals?.length > 0 && (
        <section className="card" style={{ marginBottom: 16 }}>
          <div className="card-title">
            {tr('Vorschläge')}{' '}<Link className="small" to={`/${vault}/proposals`} style={{ marginLeft: 'auto' }}>{tr('prüfen →')}</Link>
          </div>
          <div className="list">
            {run.proposals.map((p: any) => (
              <div key={p.id} className="list-item small">
                <StatusChip status={p.status} />
                <span className="grow">{p.title}</span>
                <Confidence value={p.confidence} />
              </div>
            ))}
          </div>
        </section>
      )}

      <details className="card">
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{tr('Eingabe')}</summary>
        <pre className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 400, overflow: 'auto' }}>
          {run.input}
        </pre>
      </details>
      {el}
    </div>
  )
}

const PHASES = ['Erkennen', 'Abgleichen', 'Anwenden'] as const

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  return m ? `${m}:${String(s % 60).padStart(2, '0')} min` : `${s} s`
}

/** Fortschritt eines laufenden Laufs: Phase, Abschnitt, Tokens, Laufzeit, Stoppen */
function LiveProgress({ progress, started, now, canStop, onStop }: { progress: any | null; started: string; now: number; canStop: boolean; onStop: () => void }) {
  const phase = progress?.phase ?? tr('Erkennen')
  const idx = PHASES.indexOf(phase)
  const elapsed = now - new Date(progress?.started ?? started).getTime()
  let detail = tr('Wartet auf das LLM …')
  if (progress) {
    if (phase === 'Erkennen') {
      const part = progress.steps > 1 ? tr('Abschnitt {step}/{steps}', { step: progress.step, steps: progress.steps }) : tr('Text')
      detail = progress.tokens ? tr('{part} · das LLM schreibt: {tokens} Tokens', { part: part, tokens: progress.tokens }) : tr('{part} · das LLM liest den Text ein …', { part: part })
    } else if (phase === 'Abgleichen') {
      detail = progress.steps ? tr('Eintrag {step}/{steps} mit dem Bestand abgleichen', { step: progress.step, steps: progress.steps }) : tr('Erkannte Einträge mit dem Bestand abgleichen')
    } else detail = tr('Änderungen werden geschrieben …')
  }
  return (
    <section className="card stack" style={{ marginBottom: 16 }} aria-live="polite">
      <div className="card-title" style={{ marginBottom: 0 }}>
        <span className="spinner" aria-hidden /> {tr('Kurator arbeitet')}
        <span className="small muted" style={{ fontWeight: 400 }}>
          {tr('seit')}{' '}{duration(elapsed)}
        </span>
        {canStop && phase !== 'Anwenden' && (
          <button className="btn small danger" style={{ marginLeft: 'auto' }} onClick={onStop}>
            <Icon name="stop" /> {tr('Stoppen')}
          </button>
        )}
      </div>
      <div className="row" style={{ gap: 6 }}>
        {PHASES.map((p, i) => (
          <span key={p} className={`chip ${i < idx ? 'ok' : i === idx ? 'accent' : ''}`}>
            {i < idx ? '✓' : i + 1} {tr(p)}
          </span>
        ))}
      </div>
      <div>{detail}</div>
      <div className="small faint">
        {tr('Der Plan erscheint, sobald alle Abschnitte erkannt sind. Bei ~8 Tokens/s dauert ein Abschnitt etwa 1–4 Minuten.')}
      </div>
    </section>
  )
}
