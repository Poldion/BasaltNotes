import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, enc } from '../lib/api'
import { useApp, useTypes } from '../lib/state'
import { Spinner } from '../lib/ui'
import { tr } from '../lib/i18n'
import { Icon } from './Icon'

const ACCEPT = '.pdf,.docx,.txt,.md,.markdown'

interface Item {
  name: string
  size: number
  status: 'wartet' | 'lädt' | 'fertig' | 'fehler'
  noteId?: string
  error?: string
}

function size(n: number): string {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
}

/** Dokumente (PDF, Word, Text) in den Eingang hochladen. */
export function DocumentUpload({ vault, campaigns, onUploaded }: { vault: string; campaigns: string[]; onUploaded: () => void }) {
  const types = useTypes(vault)
  const { vaults, features } = useApp()
  const dnd = !!vaults.find((v) => v.id === vault)?.restricted_view
  const [items, setItems] = useState<Item[]>([])
  const [drag, setDrag] = useState(false)
  const [campaign, setCampaign] = useState(campaigns.length === 1 ? campaigns[0] : '')
  const [type, setType] = useState('')
  const [visibility, setVisibility] = useState<'dm' | 'players'>(dnd ? 'dm' : 'players')
  const [curate, setCurate] = useState<'auto' | 'review' | 'none'>('auto')
  const input = useRef<HTMLInputElement>(null)
  const busy = items.some((i) => i.status === 'lädt' || i.status === 'wartet')

  const uploadAll = async (files: File[]) => {
    const fresh = files.map<Item>((f) => ({ name: f.name, size: f.size, status: 'wartet' }))
    const offset = items.length
    setItems((cur) => [...cur, ...fresh])
    for (let i = 0; i < files.length; i++) {
      const idx = offset + i
      setItems((cur) => cur.map((it, j) => (j === idx ? { ...it, status: 'lädt' } : it)))
      const fd = new FormData()
      if (campaign) fd.append('campaign', campaign)
      if (type) fd.append('type', type)
      if (dnd) fd.append('visibility', visibility)
      fd.append('curate', curate)
      fd.append('file', files[i], files[i].name)
      try {
        const r = await api<{ note_id: string }>(`/vaults/${enc(vault)}/inbox/upload`, { body: fd })
        setItems((cur) => cur.map((it, j) => (j === idx ? { ...it, status: 'fertig', noteId: r.note_id } : it)))
        onUploaded()
      } catch (e) {
        setItems((cur) => cur.map((it, j) => (j === idx ? { ...it, status: 'fehler', error: (e as Error).message } : it)))
      }
    }
  }

  const pick = (list: FileList | null) => {
    const files = Array.from(list ?? []).filter((f) => /\.(pdf|docx|txt|md|markdown)$/i.test(f.name))
    if (files.length) void uploadAll(files)
  }

  return (
    <section className="card stack" style={{ marginBottom: 18 }}>
      <div className="card-title" style={{ marginBottom: 0 }}>
        {tr('Dokumente hochladen')}
      </div>
      <div
        role="button"
        tabIndex={0}
        aria-label={tr('Dateien auswählen oder hierher ziehen')}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), input.current?.click())}
        onDragOver={(e) => {
          e.preventDefault()
          setDrag(true)
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDrag(false)
          pick(e.dataTransfer.files)
        }}
        style={{
          border: `2px dashed ${drag ? 'var(--accent)' : 'var(--border-strong)'}`,
          background: drag ? 'var(--accent-soft)' : 'var(--surface-2)',
          borderRadius: 'var(--radius)',
          padding: '22px 16px',
          textAlign: 'center',
          cursor: 'pointer',
        }}
      >
        <div aria-hidden style={{ color: 'var(--muted)' }}>
          <Icon name="upload" size={28} />
        </div>
        <div>
          <strong>{tr('PDF, Word, Text oder Markdown')}</strong> {tr('hierher ziehen oder')}{' '}<span style={{ color: 'var(--accent)' }}>{tr('auswählen')}</span>
        </div>
        <div className="small muted">{tr('{x} · mehrere Dateien möglich · max. 50 MB je Datei', { x: dnd ? tr('z. B. Pre-Game-Skripte, Abenteuer oder alte Notizen') : tr('z. B. Protokolle, Briefe oder Notizen') })}</div>
        <input ref={input} type="file" accept={ACCEPT} multiple hidden onChange={(e) => (pick(e.target.files), (e.target.value = ''))} />
      </div>
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
        <select className="input" style={{ width: 'auto' }} value={type} onChange={(e) => setType(e.target.value)} aria-label={tr('Typ der Notiz')}>
          <option value="">{tr('Ablegen als: {x}', { x: dnd ? (types.some((t) => t.name === 'script') ? tr('Skript (Vorbereitung)') : tr('Lore')) : tr('Notiz') })}</option>
          {types
            .filter((t) => !['campaign', 'fact', 'script'].includes(t.name))
            .map((t) => (
              <option key={t.name} value={t.name}>
                {tr('Ablegen als: {label}', { label: t.label })}
              </option>
            ))}
        </select>
        {dnd && (
          <select className="input" style={{ width: 'auto' }} value={visibility} onChange={(e) => setVisibility(e.target.value as 'dm' | 'players')} aria-label={tr('Sichtbarkeit')}>
            <option value="dm">{tr('Nur DM (keine Spoiler)')}</option>
            <option value="players">{tr('Für Spieler sichtbar')}</option>
          </select>
        )}
        {features.curator && (
          <select className="input" style={{ width: 'auto' }} value={curate} onChange={(e) => setCurate(e.target.value as 'auto' | 'review' | 'none')} aria-label={tr('Kurator')}>
            <option value="auto">{tr('Kurator: nach Regeln einsortieren')}</option>
            <option value="review">{tr('Kurator: alles als Vorschlag')}</option>
            <option value="none">{tr('Nur ablegen')}</option>
          </select>
        )}
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        {!features.curator ? (
          <>{tr('Der Text wird ausgelesen und als durchsuchbare Notiz abgelegt (Original als Anhang).')}</>
        ) : dnd ? (
          <>
            {tr('Der Text wird ausgelesen und als durchsuchbare Notiz abgelegt (Original als Anhang), standardmäßig als')}{' '}<strong>{tr('Skript (Vorbereitung)')}</strong> {tr('unter „Kampagne/Skripte“. Der Kurator legt daraus NPCs, Orte, Quests und Fakten an und weiß, dass ein Skript Geplantes beschreibt – bei „Nur DM“ bleibt alles für die Spieler-Sicht verborgen. Lange Skripte brauchen einige Minuten.')}
          </>
        ) : (
          <>{tr('Der Text wird ausgelesen und als durchsuchbare Notiz abgelegt (Original als Anhang). Der Kurator verknüpft darin erwähnte Personen und Projekte.')}</>
        )}{' '}
        {tr('Eingescannte PDFs ohne Text werden noch nicht erkannt.')}
      </p>
      {items.length > 0 && (
        <div className="list">
          {items.map((it, i) => (
            <div key={i} className="list-item small">
              <Icon name="file" />
              <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {it.noteId ? <Link to={`/${vault}/note/${enc(it.noteId)}`}>{it.name}</Link> : it.name}
                {it.error && <div style={{ color: 'var(--danger)' }}>{it.error}</div>}
              </span>
              <span className="faint">{size(it.size)}</span>
              {it.status === 'lädt' ? (
                <Spinner />
              ) : (
                <span className={`chip ${it.status === 'fertig' ? 'ok' : it.status === 'fehler' ? 'danger' : 'warn'}`}>{it.status === 'fertig' ? tr('eingeliefert') : tr(it.status)}</span>
              )}
            </div>
          ))}
          {!busy && (
            <button className="btn small ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setItems([])}>
              {tr('Liste leeren')}
            </button>
          )}
        </div>
      )}
    </section>
  )
}
