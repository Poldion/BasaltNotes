import { useEffect, useState } from 'react'
import type { PropDef, TypeSchema } from '../lib/api'
import { loadNames } from './Editor'
import { tr } from '../lib/i18n'

const HIDDEN = new Set(['id', 'title', 'created', 'updated'])

function unlink(v: any): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  const m = /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(s.trim())
  return m ? m[1] : s
}

export function TagInput({ value, onChange, placeholder, suggestions }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; suggestions?: string }) {
  const [text, setText] = useState('')
  const add = (raw: string) => {
    const parts = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (!parts.length) return
    onChange([...value, ...parts.filter((p) => !value.includes(p))])
    setText('')
  }
  return (
    <div className="tag-input">
      {value.map((v) => (
        <span key={v} className="chip accent">
          {v}
          <button type="button" aria-label={`${v} entfernen`} onClick={() => onChange(value.filter((x) => x !== v))}>
            ×
          </button>
        </span>
      ))}
      <input
        value={text}
        list={suggestions}
        placeholder={value.length ? '' : placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            add(text)
          } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1))
        }}
        onBlur={() => add(text)}
      />
    </div>
  )
}

function PlayersInput({ value, onChange }: { value: any[]; onChange: (v: any[]) => void }) {
  const rows = Array.isArray(value) ? value : []
  const set = (i: number, k: string, v: string) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v || null } : r)))
  return (
    <div className="stack" style={{ gap: 4 }}>
      {rows.map((r, i) => (
        <div key={i} className="row" style={{ flexWrap: 'nowrap' }}>
          <input className="input" placeholder="Spieler:in" value={r?.player ?? ''} onChange={(e) => set(i, 'player', e.target.value)} />
          <input className="input" placeholder={tr('Charakter')} value={r?.character ?? ''} onChange={(e) => set(i, 'character', e.target.value)} />
          <button type="button" className="icon-btn" aria-label={tr('Entfernen')} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="btn small ghost" style={{ alignSelf: 'flex-start' }} onClick={() => onChange([...rows, { player: '', character: null }])}>
        {tr('+ Spieler:in')}
      </button>
    </div>
  )
}

function Field({ def, value, onChange, listId }: { def: PropDef; value: any; onChange: (v: any) => void; listId: string }) {
  const id = `prop-${def.name}`
  switch (def.type) {
    case 'list':
      return <TagInput value={Array.isArray(value) ? value.map(String) : value ? [String(value)] : []} onChange={onChange} placeholder={tr('Eintrag + Enter')} />
    case 'players':
      return <PlayersInput value={value} onChange={onChange} />
    case 'boolean':
      return <input id={id} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
    case 'number':
      return <input id={id} className="input" type="number" value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />
    case 'date':
      return <input id={id} className="input" type="date" value={value ? String(value).slice(0, 10) : ''} onChange={(e) => onChange(e.target.value || null)} />
    case 'datetime': {
      const local = value ? String(value).slice(0, 16) : ''
      return (
        <input
          id={id}
          className="input"
          type="datetime-local"
          value={local}
          onChange={(e) => {
            if (!e.target.value) return onChange(null)
            const d = new Date(e.target.value)
            const off = -d.getTimezoneOffset()
            const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, '0')
            onChange(`${e.target.value}:00${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`)
          }}
        />
      )
    }
    case 'select':
      return (
        <select id={id} className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">–</option>
          {(def.options ?? []).map((o) => (
            <option key={o} value={o}>
              {tr(o)}
            </option>
          ))}
          {value && !(def.options ?? []).includes(String(value)) && <option value={String(value)}>{String(value)}</option>}
        </select>
      )
    case 'link':
      return (
        <input
          id={id}
          className="input"
          list={listId}
          value={unlink(value)}
          placeholder={tr('Notiz verknüpfen …')}
          onChange={(e) => onChange(e.target.value ? (def.name === 'campaign' ? e.target.value : `[[${e.target.value}]]`) : null)}
        />
      )
    default:
      return <input id={id} className="input" type={def.type === 'url' ? 'url' : 'text'} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} />
  }
}

export function PropertiesForm({
  vault,
  types,
  type,
  frontmatter,
  onChange,
  readOnly,
}: {
  vault: string
  types: TypeSchema[]
  type: string
  frontmatter: Record<string, any>
  onChange: (fm: Record<string, any>) => void
  readOnly?: boolean
}) {
  const [titles, setTitles] = useState<string[]>([])
  const [open, setOpen] = useState(true)
  const listId = `titles-${vault}`
  useEffect(() => {
    loadNames(vault)
      .then((n) => setTitles(n.items.map((i) => i.title)))
      .catch(() => undefined)
  }, [vault])

  const schema = types.find((t) => t.name === type)
  const defs = schema?.properties ?? []
  const known = new Set(defs.map((d) => d.name))
  const extra = Object.keys(frontmatter).filter((k) => !known.has(k) && !HIDDEN.has(k) && k !== 'type')
  const set = (k: string, v: any) => {
    const next = { ...frontmatter }
    if (v === null || v === undefined || (Array.isArray(v) && !v.length)) delete next[k]
    else next[k] = v
    onChange(next)
  }

  return (
    <section className="props" aria-label={tr('Eigenschaften')}>
      <div className="props-head">
        <button className="icon-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? '▼' : '▶'}
        </button>
        <span className="grow">{tr('Eigenschaften')}</span>
        <label className="row small" style={{ gap: 6 }}>
          {tr('Typ')}
          <select className="input" style={{ width: 'auto', padding: '2px 6px' }} value={type} disabled={readOnly} onChange={(e) => onChange({ ...frontmatter, type: e.target.value })}>
            {types.map((t) => (
              <option key={t.name} value={t.name}>
                {t.label}
              </option>
            ))}
            {!schema && <option value={type}>{type}</option>}
          </select>
        </label>
      </div>
      {open && (
        <fieldset className="props-grid" disabled={readOnly} style={{ border: 'none', margin: 0 }}>
          <datalist id={listId}>
            {titles.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          {defs.map((d) => (
            <FieldRow key={d.name} label={d.label} htmlFor={`prop-${d.name}`}>
              <Field def={d} value={frontmatter[d.name]} onChange={(v) => set(d.name, v)} listId={listId} />
            </FieldRow>
          ))}
          {extra.map((k) => (
            <FieldRow key={k} label={k} htmlFor={`prop-${k}`}>
              {Array.isArray(frontmatter[k]) && frontmatter[k].every((x: any) => typeof x !== 'object') ? (
                <TagInput value={frontmatter[k].map(String)} onChange={(v) => set(k, v)} />
              ) : typeof frontmatter[k] === 'object' && frontmatter[k] !== null ? (
                <input className="input mono" id={`prop-${k}`} defaultValue={JSON.stringify(frontmatter[k])} onBlur={(e) => {
                  try {
                    set(k, JSON.parse(e.target.value))
                  } catch {
                    // ungültig: ignorieren
                  }
                }} />
              ) : (
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <input className="input" id={`prop-${k}`} value={frontmatter[k] ?? ''} onChange={(e) => set(k, e.target.value)} />
                  <button type="button" className="icon-btn" title={tr('Eigenschaft entfernen')} onClick={() => set(k, null)}>
                    ✕
                  </button>
                </div>
              )}
            </FieldRow>
          ))}
          {!readOnly && <AddProperty onAdd={(k) => set(k, '')} existing={new Set([...known, ...extra])} />}
        </fieldset>
      )}
    </section>
  )
}

function FieldRow({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <>
      <label className="k" htmlFor={htmlFor} title={label}>
        {label}
      </label>
      <div>{children}</div>
    </>
  )
}

function AddProperty({ onAdd, existing }: { onAdd: (k: string) => void; existing: Set<string> }) {
  const [k, setK] = useState('')
  const ok = /^[\p{L}_][\p{L}\p{N}_-]*$/u.test(k) && !existing.has(k) && !HIDDEN.has(k)
  return (
    <>
      <span className="k">{tr('Neue Eigenschaft')}</span>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input className="input" placeholder="name" value={k} onChange={(e) => setK(e.target.value.trim())} onKeyDown={(e) => e.key === 'Enter' && ok && (onAdd(k), setK(''))} />
        <button type="button" className="btn small" disabled={!ok} onClick={() => (onAdd(k), setK(''))}>
          {tr('Hinzufügen')}
        </button>
      </div>
    </>
  )
}
