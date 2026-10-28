import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { locale, tr } from './i18n'

export const TYPE_COLORS: Record<string, string> = {
  campaign: '#e57d43',
  session: '#d4a72c',
  character: '#4fa3e0',
  npc: '#9b7be3',
  location: '#4cb782',
  faction: '#e05d7a',
  item: '#c9a46b',
  monster: '#d9534f',
  quest: '#f0b429',
  lore: '#7aa0b8',
  script: '#c46bd1',
  fact: '#8c9199',
  note: '#8c9199',
  meeting: '#d4a72c',
  person: '#9b7be3',
  project: '#4cb782',
  journal: '#e8a87c',
  task: '#f0b429',
  list: '#5bc0be',
  event: '#4fa3e0',
  recipe: '#e57d43',
  idea: '#c46bd1',
  bookmark: '#7aa0b8',
  howto: '#8fbf6a',
}

export function typeColor(t: string): string {
  if (TYPE_COLORS[t]) return TYPE_COLORS[t]
  let h = 0
  for (const c of t) h = (h * 31 + c.charCodeAt(0)) % 360
  return `hsl(${h} 45% 58%)`
}

export function TypeDot({ type }: { type: string }) {
  return <span className="type-dot" style={{ background: typeColor(type) }} aria-hidden />
}

const dtf = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
const df = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' })

export function fmtDateTime(v?: string | null): string {
  if (!v) return '–'
  const d = new Date(v)
  return isNaN(d.getTime()) ? String(v) : dtf.format(d)
}

export function fmtDate(v?: string | null): string {
  if (!v) return '–'
  const d = new Date(v)
  return isNaN(d.getTime()) ? String(v) : df.format(d)
}

export function relTime(v?: string | null): string {
  if (!v) return ''
  const d = new Date(v).getTime()
  if (isNaN(d)) return ''
  const s = Math.round((Date.now() - d) / 1000)
  if (s < 60) return tr('gerade eben')
  if (s < 3600) return tr('vor {x} Min.', { x: Math.round(s / 60) })
  if (s < 86400) return tr('vor {x} Std.', { x: Math.round(s / 3600) })
  if (s < 86400 * 30) return tr('vor {x} Tagen', { x: Math.round(s / 86400) })
  return fmtDate(v)
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function Modal({ title, onClose, children, footer, className }: { title?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; className?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${className ?? ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        {title && (
          <div className="modal-head">
            <span className="grow">{title}</span>
            <button className="icon-btn" onClick={onClose} aria-label={tr('Schließen')}>
              ✕
            </button>
          </div>
        )}
        {children}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

/** Eingabedialog als Promise. */
export function usePrompt() {
  const [state, setState] = useState<{ title: string; label: string; value: string; resolve: (v: string | null) => void } | null>(null)
  const ask = (title: string, label: string, value = '') => new Promise<string | null>((resolve) => setState({ title, label, value, resolve }))
  const el = state ? <PromptDialog {...state} onDone={(v) => (state.resolve(v), setState(null))} /> : null
  return { ask, el }
}

function PromptDialog({ title, label, value, onDone }: { title: string; label: string; value: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <Modal
      title={title}
      onClose={() => onDone(null)}
      footer={
        <>
          <button className="btn" onClick={() => onDone(null)}>
            {tr('Abbrechen')}
          </button>
          <button className="btn primary" onClick={() => onDone(v.trim() || null)}>
            OK
          </button>
        </>
      }
    >
      <div className="modal-body">
        <label className="field">
          <span>{label}</span>
          <input ref={ref} className="input" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onDone(v.trim() || null)} />
        </label>
      </div>
    </Modal>
  )
}

export function Confirm({ text, onYes, onNo, yes = 'Ja', danger }: { text: ReactNode; onYes: () => void; onNo: () => void; yes?: string; danger?: boolean }) {
  return (
    <Modal
      title={tr('Bestätigen')}
      onClose={onNo}
      footer={
        <>
          <button className="btn" onClick={onNo}>
            {tr('Abbrechen')}
          </button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onYes} autoFocus>
            {yes}
          </button>
        </>
      }
    >
      <div className="modal-body">{text}</div>
    </Modal>
  )
}

export function useConfirm() {
  const [state, setState] = useState<{ text: ReactNode; yes?: string; danger?: boolean; resolve: (v: boolean) => void } | null>(null)
  const confirm = (text: ReactNode, opts: { yes?: string; danger?: boolean } = {}) => new Promise<boolean>((resolve) => setState({ text, ...opts, resolve }))
  const el = state ? (
    <Confirm
      text={state.text}
      yes={state.yes}
      danger={state.danger}
      onYes={() => (state.resolve(true), setState(null))}
      onNo={() => (state.resolve(false), setState(null))}
    />
  ) : null
  return { confirm, el }
}

/** Unified-Diff farbig darstellen. */
export function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n')
  return (
    <div className="diff" role="region" aria-label={tr('Änderungen')}>
      {lines.map((l, i) => {
        const cls = l.startsWith('@@') ? 'hunk' : l.startsWith('+++') || l.startsWith('---') || l.startsWith('===') || l.startsWith('Index:') ? 'meta' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''
        return (
          <div key={i} className={cls}>
            {l || ' '}
          </div>
        )
      })}
    </div>
  )
}

export function Confidence({ value }: { value: number | null | undefined }) {
  const v = Math.round((value ?? 0) * 100)
  return (
    <span className="row small muted" title={tr('Sicherheit {v} %', { v: v })} style={{ gap: 6 }}>
      <span className="confidence">
        <span style={{ width: `${v}%` }} />
      </span>
      {v} %
    </span>
  )
}

export function StatusChip({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    queued: ['wartet', 'warn'],
    running: [tr('läuft'), 'accent'],
    processed: ['verarbeitet', 'ok'],
    stored: ['abgelegt', 'ok'],
    error: [tr('Fehler'), 'danger'],
    discarded: ['verworfen', ''],
    open: ['offen', 'warn'],
    accepted: ['angenommen', 'ok'],
    rejected: ['abgelehnt', ''],
    superseded: [tr('überholt'), ''],
    done: ['fertig', 'ok'],
    planned: [tr('Trockenlauf'), 'accent'],
    reverted: [tr('rückgängig'), 'danger'],
    cancelled: ['abgebrochen', ''],
    interrupted: ['unterbrochen', 'warn'],
  }
  const [label, cls] = map[status] ?? [status, '']
  return <span className={`chip ${cls}`}>{label}</span>
}

export function Spinner() {
  return <span className="spinner" role="status" aria-label={tr('Lädt')} />
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

export const OP_LABELS: Record<string, string> = {
  create_entity: tr('Neu anlegen'),
  append_block: tr('Beitrag ergänzen'),
  add_mention: tr('Erwähnung'),
  add_alias: tr('Alias'),
  update_property: tr('Eigenschaft ändern'),
  contradiction: tr('Widerspruch'),
  merge_entities: tr('Zusammenführen'),
  update_quest: 'Quest-Status',
  delete: tr('Löschen'),
  remove_block: tr('Bereich entfernt'),
  link_mentions: tr('Verknüpfen'),
}
