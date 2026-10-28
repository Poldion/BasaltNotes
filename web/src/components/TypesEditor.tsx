import { useCallback, useEffect, useState } from 'react'
import { api, enc, type PropDef } from '../lib/api'
import { invalidateTypes, useApp } from '../lib/state'
import { Modal, Spinner, TypeDot, useConfirm } from '../lib/ui'
import { tr } from '../lib/i18n'

interface TypeRow {
  name: string
  label: string
  folder: string
  template: string | null
  builtin?: boolean
  properties: PropDef[]
}

const FIELD_TYPES: [PropDef['type'], string][] = [
  ['text', tr('Text')],
  ['number', tr('Zahl')],
  ['date', tr('Datum')],
  ['datetime', tr('Datum + Uhrzeit')],
  ['boolean', 'Ja/Nein'],
  ['select', tr('Auswahl')],
  ['list', tr('Liste')],
  ['link', tr('Verweis auf Notiz')],
  ['url', tr('Webadresse')],
]

const COMMON = new Set(['aliases', 'tags', 'visibility'])

interface Draft {
  isNew: boolean
  name: string
  label: string
  folder: string
  template_body: string
  properties: (PropDef & { optionsText?: string })[]
  note_count?: number
}

/** Kurzname aus der Bezeichnung: „Wein & Sekt“ → „wein-sekt“ */
function slug(label: string): string {
  return label
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^(\d)/, 't$1')
    .slice(0, 30)
}

/** Typen eines Notizbuchs verwalten: Bezeichnung, Ordner, Felder, Vorlage */
export function TypesEditor({ vault }: { vault: string }) {
  const { toast } = useApp()
  const [items, setItems] = useState<TypeRow[] | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const { confirm, el } = useConfirm()

  const load = useCallback(() => {
    api<{ items: TypeRow[] }>(`/vaults/${enc(vault)}/types`)
      .then((r) => setItems(r.items))
      .catch(() => setItems([]))
  }, [vault])
  useEffect(load, [load])

  const edit = async (t: TypeRow) => {
    try {
      const r = await api<TypeRow & { template_body: string | null; note_count: number }>(`/vaults/${enc(vault)}/types/${enc(t.name)}`)
      setDraft({
        isNew: false,
        name: r.name,
        label: r.label,
        folder: r.folder,
        template_body: r.template_body ?? '',
        note_count: r.note_count,
        properties: r.properties.filter((p) => !COMMON.has(p.name)).map((p) => ({ ...p, optionsText: (p.options ?? []).join(', ') })),
      })
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const create = () => setDraft({ isNew: true, name: '', label: '', folder: '', template_body: '# {{title}}\n\n', properties: [] })

  const save = async () => {
    if (!draft) return
    const name = draft.isNew ? draft.name || slug(draft.label) : draft.name
    setSaving(true)
    try {
      await api(`/vaults/${enc(vault)}/types/${enc(name)}`, {
        method: 'PUT',
        body: {
          label: draft.label.trim(),
          folder: draft.folder.trim(),
          template_body: draft.template_body,
          properties: draft.properties
            .filter((p) => p.name.trim())
            .map((p) => ({
              name: p.name.trim(),
              label: p.label?.trim() || p.name.trim(),
              type: p.type,
              ...(p.type === 'select' ? { options: (p.optionsText ?? '').split(',').map((o) => o.trim()).filter(Boolean) } : {}),
              ...(p.type === 'link' && p.link_types?.length ? { link_types: p.link_types } : {}),
            })),
        },
      })
      invalidateTypes(vault)
      toast(tr('Typ „{label}“ gespeichert', { label: draft.label }), 'success')
      setDraft(null)
      load()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!draft || draft.isNew) return
    if (!(await confirm(<>{tr('Typ „{label}“ entfernen? Das geht nur, wenn es keine Notizen dieses Typs mehr gibt.', { label: draft.label })}</>, { yes: tr('Entfernen'), danger: true }))) return
    try {
      await api(`/vaults/${enc(vault)}/types/${enc(draft.name)}`, { method: 'DELETE' })
      invalidateTypes(vault)
      setDraft(null)
      load()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const setProp = (i: number, patch: Partial<PropDef & { optionsText?: string }>) =>
    draft && setDraft({ ...draft, properties: draft.properties.map((p, j) => (j === i ? { ...p, ...patch } : p)) })

  return (
    <section className="card stack">
      <div className="row">
        <div className="card-title grow" style={{ marginBottom: 0 }}>
          {tr('Typen')}
        </div>
        <button className="btn small" onClick={create}>
          {tr('+ Neuer Typ')}
        </button>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        {tr('Welche Arten von Notizen es gibt – mit eigenen Feldern, Ordner und Vorlage. Z. B. „Wein“ mit Weingut und Bewertung, oder „Pflanze“ mit Gießintervall.')}
      </p>
      {items === null ? (
        <Spinner />
      ) : (
        <div className="types-grid">
          {items.map((t) => (
            <button key={t.name} className="type-tile" onClick={() => void edit(t)}>
              <span className="row" style={{ gap: 6 }}>
                <TypeDot type={t.name} />
                <strong>{tr(t.label)}</strong>
              </span>
              <span className="small faint">
                {tr('{x} · {length} Felder', { x: t.folder || tr('Hauptordner'), length: t.properties.filter((p) => !COMMON.has(p.name)).length })}
              </span>
            </button>
          ))}
        </div>
      )}
      {draft && (
        <Modal
          title={draft.isNew ? tr('Neuer Typ') : tr('Typ „{label}“', { label: draft.label })}
          className="wide"
          onClose={() => setDraft(null)}
          footer={
            <>
              {!draft.isNew && (
                <button className="btn danger" onClick={remove} style={{ marginRight: 'auto' }} disabled={!!draft.note_count} title={draft.note_count ? tr('Es gibt noch {note_count} Notizen dieses Typs', { note_count: draft.note_count }) : undefined}>
                  {tr('Entfernen')}
                </button>
              )}
              <button className="btn" onClick={() => setDraft(null)}>
                {tr('Abbrechen')}
              </button>
              <button className="btn primary" onClick={save} disabled={saving || !draft.label.trim()}>
                {saving ? <Spinner /> : tr('Speichern')}
              </button>
            </>
          }
        >
          <div className="modal-body stack">
            <div className="grid-2">
              <label className="field">
                <span>{tr('Bezeichnung')}</span>
                <input className="input" value={draft.label} placeholder={tr('z. B. Wein')} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
              </label>
              <label className="field">
                <span>{tr('Kurzname {x}', { x: draft.isNew ? tr('(für Dateien und API)') : '' })}</span>
                <input
                  className="input mono"
                  value={draft.isNew ? draft.name || slug(draft.label) : draft.name}
                  disabled={!draft.isNew}
                  onChange={(e) => setDraft({ ...draft, name: slug(e.target.value) })}
                />
              </label>
            </div>
            <label className="field">
              <span>{tr('Ordner')}</span>
              <input className="input" value={draft.folder} placeholder={tr('z. B. Sammlungen/Wein – leer = Hauptordner')} onChange={(e) => setDraft({ ...draft, folder: e.target.value })} />
              <span className="small faint">
                {tr('Platzhalter:')}{' '}<code>{'{year}'}</code>, <code>{'{month}'}</code>, <code>{'{campaign}'}</code>, <code>{'{title}'}</code>
              </span>
            </label>

            <div className="field">
              <span>{tr('Felder')}</span>
              <div className="stack" style={{ gap: 6 }}>
                {draft.properties.map((p, i) => (
                  <div key={i} className="prop-row">
                    <input className="input" placeholder={tr('Bezeichnung')} value={p.label ?? ''} onChange={(e) => setProp(i, { label: e.target.value, ...(p.name || !draft.isNew ? {} : {}) })} />
                    <input
                      className="input mono"
                      placeholder="feldname"
                      value={p.name}
                      onChange={(e) => setProp(i, { name: e.target.value.replace(/[^a-zA-Z0-9_]/g, '') })}
                      onFocus={() => !p.name && p.label && setProp(i, { name: slug(p.label).replace(/-/g, '_') })}
                    />
                    <select className="input" value={p.type} onChange={(e) => setProp(i, { type: e.target.value as PropDef['type'] })}>
                      {FIELD_TYPES.map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                    <button className="btn small ghost" aria-label={tr('Feld entfernen')} onClick={() => setDraft({ ...draft, properties: draft.properties.filter((_x, j) => j !== i) })}>
                      ✕
                    </button>
                    {p.type === 'select' && (
                      <input className="input prop-options" placeholder={tr('Optionen, durch Komma getrennt')} value={p.optionsText ?? ''} onChange={(e) => setProp(i, { optionsText: e.target.value })} />
                    )}
                    {p.type === 'link' && (
                      <select
                        className="input prop-options"
                        value={p.link_types?.[0] ?? ''}
                        onChange={(e) => setProp(i, { link_types: e.target.value ? [e.target.value] : [] })}
                      >
                        <option value="">{tr('auf beliebige Notizen')}</option>
                        {(items ?? []).map((t) => (
                          <option key={t.name} value={t.name}>
                            {tr('nur auf')}{' '}{tr(t.label)}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                ))}
                <div>
                  <button className="btn small" onClick={() => setDraft({ ...draft, properties: [...draft.properties, { name: '', label: '', type: 'text' }] })}>
                    {tr('+ Feld')}
                  </button>
                </div>
              </div>
              <span className="small faint">{tr('Aliasse und Tags hat jeder Typ automatisch.')}</span>
            </div>

            <label className="field">
              <span>{tr('Vorlage für neue Notizen')}</span>
              <textarea className="input mono" rows={7} value={draft.template_body} onChange={(e) => setDraft({ ...draft, template_body: e.target.value })} spellCheck={false} />
              <span className="small faint">
                {tr('Platzhalter:')}{' '}<code>{'{{title}}'}</code>, <code>{'{{date}}'}</code>
              </span>
            </label>
          </div>
        </Modal>
      )}
      {el}
    </section>
  )
}
