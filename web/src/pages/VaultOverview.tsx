import { useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { api, enc, type NoteSummary } from '../lib/api'
import { useApp } from '../lib/state'
import { Spinner, TypeDot, relTime } from '../lib/ui'
import { tr } from '../lib/i18n'

type Recent = NoteSummary & { vault: string }

/** Startseite: alle Vaults des Zugangs und die zuletzt geänderten Notizen daraus */
export function VaultOverview() {
  const { vaults, refreshVaults, isAdmin, isPlayer } = useApp()
  const [presets, setPresets] = useState<{ id: string; label: string }[]>([])
  const [recent, setRecent] = useState<Recent[] | null>(null)
  const ids = vaults.map((v) => v.id).join('\n')

  useEffect(() => {
    document.title = tr('{x} – BasaltNotes', { x: tr('Übersicht') })
    void refreshVaults().catch(() => undefined)
    api<{ items: { id: string; label: string }[] }>('/presets').then((r) => setPresets(r.items)).catch(() => undefined)
  }, [refreshVaults])

  useEffect(() => {
    let alive = true
    // Je Vault über die normale Notizliste, damit Bereiche und Spieler-Sicht wie überall gelten
    Promise.all(
      (ids ? ids.split('\n') : []).map((id) =>
        api<{ items: NoteSummary[] }>(`/vaults/${enc(id)}/notes?limit=10&sort=-updated&fields=title,type,path,updated`)
          .then((r) => r.items.map((n) => ({ ...n, vault: id })))
          .catch(() => [] as Recent[]),
      ),
    ).then((lists) => {
      if (alive) setRecent(lists.flat())
    })
    return () => {
      alive = false
    }
  }, [ids])

  // Spieler haben meist genau eine Runde, die Übersicht wäre nur ein Umweg
  if (isPlayer && vaults.length === 1) return <Navigate to={`/${vaults[0].id}`} replace />

  // Die Listen sind je Vault absteigend sortiert, der erste Treffer ist also der neueste
  const newest = (id: string) => recent?.find((n) => n.vault === id)?.updated
  const latest = [...(recent ?? [])].sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? '')).slice(0, 10)
  const presetLabel = (id: string) => {
    const label = presets.find((p) => p.id === id)?.label
    return label ? tr(label) : id
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>{tr('Übersicht')}</h1>
        {isAdmin && (
          <Link className="btn small primary" to="/settings#vaults">
            {tr('+ Neuer Vault …')}
          </Link>
        )}
      </div>

      {vaults.length === 0 ? (
        <div className="empty">{isAdmin ? tr('Noch keine Vaults. Lege den ersten an.') : tr('Dir ist noch kein Vault freigegeben.')}</div>
      ) : (
        <div className="stack">
          <div className="vault-grid">
            {vaults.map((v) => {
              const changed = newest(v.id)
              return (
                <Link key={v.id} className="card vault-card" to={`/${v.id}`}>
                  <strong className="vault-card-name">{v.name}</strong>
                  <span className="chip">{presetLabel(v.preset)}</span>
                  <span className="small faint">
                    {tr('{x} Notizen', { x: v.note_count })}
                    {changed ? ` · ${relTime(changed)}` : ''}
                  </span>
                </Link>
              )
            })}
          </div>

          <section className="card">
            <div className="card-title">{tr('Zuletzt geändert')}</div>
            {recent === null ? (
              <Spinner />
            ) : latest.length === 0 ? (
              <div className="empty small">{tr('Noch keine Notizen.')}</div>
            ) : (
              <div className="list">
                {latest.map((n) => (
                  <Link key={`${n.vault}:${n.id}`} className="list-item" to={`/${n.vault}/note/${enc(n.id)}`}>
                    <TypeDot type={n.type} />
                    <span className="grow">{n.title}</span>
                    <span className="small faint">{vaults.find((v) => v.id === n.vault)?.name ?? n.vault}</span>
                    <span className="small faint" style={{ minWidth: 90, textAlign: 'right' }}>
                      {relTime(n.updated)}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
