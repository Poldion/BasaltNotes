import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, enc } from '../lib/api'
import { useApp, useVaultEvents } from '../lib/state'
import { tr } from '../lib/i18n'
import { Icon } from './Icon'

interface Progress {
  run_id: string
  inbox_id: string | null
  title: string
  dry_run: boolean
  phase: string
  step: number
  steps: number
  tokens?: number
  started: string
}

/** „Kurator arbeitet …“ mit Stopp-Knopf – sichtbar, solange etwas läuft oder wartet. */
export function CuratorIndicator({ vault }: { vault: string }) {
  const { me, toast, isPlayer } = useApp()
  const canCurate = !!me?.scopes.some((s) => ['curate', 'admin'].includes(s))
  const [status, setStatus] = useState<{ running: Progress[]; queued: number } | null>(null)
  const [stopping, setStopping] = useState(false)

  const load = useCallback(() => {
    if (isPlayer) return
    api<{ running: Progress[]; queued: number }>(`/vaults/${enc(vault)}/curator/status`)
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [vault, isPlayer])

  const active = !!status && (status.running.length > 0 || status.queued > 0)

  // Während der Kurator arbeitet häufiger nachsehen (Fortschritt), sonst selten
  useEffect(() => {
    load()
    const t = setInterval(load, active ? 2500 : 20000)
    return () => clearInterval(t)
  }, [load, active])
  useVaultEvents(vault, (e) => {
    if (e.event.startsWith('inbox.') || e.event === 'run.reverted') load()
  })
  useEffect(() => {
    if (!active) setStopping(false)
  }, [active])

  if (isPlayer || !status || !active) return null
  const cur = status.running[0]

  const stop = async () => {
    setStopping(true)
    try {
      const r = await api<{ stopped_running: number; cancelled_queued: number }>(`/vaults/${enc(vault)}/curator/stop`, { method: 'POST' })
      toast(tr('Kurator gestoppt{x}. Abgebrochene Einträge lassen sich im Eingang neu verarbeiten.', { x: r.cancelled_queued ? tr(' – {cancelled_queued} wartende Aufträge verworfen', { cancelled_queued: r.cancelled_queued }) : '' }), 'success')
      load()
    } catch (e) {
      setStopping(false)
      toast((e as Error).message, 'error')
    }
  }

  return (
    <div
      role="status"
      aria-live="polite"
      style={{ margin: '6px 8px', padding: '8px 10px', borderRadius: 'var(--radius)', background: 'var(--accent-soft)', border: '1px solid var(--accent)', fontSize: 13 }}
    >
      <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
        <span className="spinner" aria-hidden style={{ width: 12, height: 12 }} />
        <strong className="grow">{stopping ? tr('Kurator wird gestoppt …') : tr('Kurator arbeitet')}</strong>
        {canCurate && (
          <button className="btn small danger" onClick={stop} disabled={stopping} title={tr('Laufenden Kurator-Lauf abbrechen und Warteschlange leeren')}>
            <Icon name="stop" /> {tr('Stoppen')}
          </button>
        )}
      </div>
      {cur && (
        <div className="muted" style={{ marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={cur.title}>
          {cur.dry_run ? tr('Trockenlauf: ') : ''}
          {cur.inbox_id ? <Link to={`/${vault}/inbox`}>{cur.title}</Link> : cur.title}
          <div className="faint">
            {cur.phase}
            {cur.steps > 1 ? ` · ${cur.phase === 'Erkennen' ? tr('Abschnitt') : tr('Eintrag')} ${cur.step}/${cur.steps}` : ''}
            {cur.phase === 'Erkennen' ? (cur.tokens ? tr(' · {tokens} Tokens', { tokens: cur.tokens }) : tr(' · LLM liest …')) : ''}
          </div>
        </div>
      )}
      {status.queued > 0 && <div className="faint" style={{ marginTop: 2 }}>{tr('+ {queued} in der Warteschlange', { queued: status.queued })}</div>}
    </div>
  )
}
