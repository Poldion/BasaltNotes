import { useEffect, useState } from 'react'
import { api, enc } from '../lib/api'
import { useApp, useTypes } from '../lib/state'
import { Modal } from '../lib/ui'
import { tr } from '../lib/i18n'

export function NewNoteDialog({
  vault,
  folder,
  initialTitle,
  initialType,
  campaign,
  onClose,
  onCreated,
}: {
  vault: string
  folder?: string
  initialTitle?: string
  initialType?: string
  campaign?: string
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const types = useTypes(vault)
  const { toast } = useApp()
  const [title, setTitle] = useState(initialTitle ?? '')
  const [type, setType] = useState(initialType ?? (folder !== undefined ? 'note' : ''))
  const [camp, setCamp] = useState(campaign ?? '')
  const [campaigns, setCampaigns] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  // Ordner: leer = Standardordner des Typs
  const [dir, setDir] = useState(folder ?? '')
  const [folders, setFolders] = useState<string[]>([])

  useEffect(() => {
    api<{ folders: string[] }>(`/vaults/${enc(vault)}/tree`)
      .then((r) => setFolders(r.folders))
      .catch(() => undefined)
  }, [vault])

  useEffect(() => {
    api<{ items: { title: string }[] }>(`/vaults/${enc(vault)}/campaigns`)
      .then((r) => {
        setCampaigns(r.items.map((c) => c.title))
        if (!campaign && r.items.length === 1) setCamp(r.items[0].title)
      })
      .catch(() => undefined)
  }, [vault, campaign])

  useEffect(() => {
    if (!type && types.length) setType(types.find((t) => t.name === 'note') ? 'note' : types[0].name)
  }, [types, type])

  const def = types.find((t) => t.name === type)
  const needsCampaign = !!def && (def.folder.includes('{campaign}') || def.properties.some((p) => p.name === 'campaign'))

  const create = async () => {
    if (!title.trim()) return
    setBusy(true)
    try {
      const body: any = { title: title.trim(), type }
      const d = dir.trim().replace(/^\/+|\/+$/g, '')
      if (d || folder !== undefined) body.folder = d
      if (needsCampaign && camp) body.frontmatter = { campaign: camp }
      const n = await api<{ id: string }>(`/vaults/${enc(vault)}/notes`, { body })
      onCreated(n.id)
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={tr('Neue Notiz')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {tr('Abbrechen')}
          </button>
          <button className="btn primary" onClick={create} disabled={busy || !title.trim()}>
            {tr('Anlegen')}
          </button>
        </>
      }
    >
      <div className="modal-body stack">
        <label className="field">
          <span>{tr('Titel')}</span>
          <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
        </label>
        {types.length > 1 && (
          <label className="field">
            <span>{tr('Typ (bestimmt Vorlage, Eigenschaften und den Standardordner)')}</span>
            <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
              {types.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {needsCampaign && type !== 'campaign' && (
          <label className="field">
            <span>{tr('Kampagne')}</span>
            <input className="input" list="campaign-list" value={camp} onChange={(e) => setCamp(e.target.value)} />
            <datalist id="campaign-list">
              {campaigns.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>
        )}
        <label className="field">
          <span>{tr('Ordner')}</span>
          <input
            className="input"
            list="folder-list"
            value={dir}
            placeholder={def?.folder ? tr('Standard: {folder}', { folder: def.folder }) : tr('(oberste Ebene)')}
            onChange={(e) => setDir(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
          />
          <datalist id="folder-list">
            {folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </label>
      </div>
    </Modal>
  )
}
