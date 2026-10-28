import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, enc } from '../lib/api'
import { useApp } from '../lib/state'
import { Spinner, relTime, useConfirm } from '../lib/ui'
import { tr } from '../lib/i18n'

export function TrashPage() {
  const { vault = '' } = useParams()
  const { toast, canWrite, isAdmin } = useApp()
  const navigate = useNavigate()
  const { confirm, el } = useConfirm()
  const [items, setItems] = useState<{ path: string; title: string; deleted: string }[] | null>(null)
  const load = useCallback(() => {
    api<{ items: any[] }>(`/vaults/${enc(vault)}/trash`)
      .then((r) => setItems(r.items))
      .catch(() => setItems([]))
  }, [vault])
  useEffect(load, [load])

  const restore = async (path: string) => {
    try {
      const n = await api<{ id: string }>(`/vaults/${enc(vault)}/trash/restore`, { body: { path } })
      toast(tr('Wiederhergestellt'), 'success')
      navigate(`/${vault}/note/${enc(n.id)}`)
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  const empty = async () => {
    if (!(await confirm(tr('Papierkorb endgültig leeren? Ältere Stände bleiben im git-Verlauf erhalten.'), { yes: tr('Leeren'), danger: true }))) return
    await api(`/vaults/${enc(vault)}/trash`, { method: 'DELETE' })
    load()
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>{tr('Papierkorb')}</h1>
        {isAdmin && !!items?.length && (
          <button className="btn danger small" onClick={empty}>
            {tr('Papierkorb leeren')}
          </button>
        )}
      </div>
      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <div className="empty">{tr('Der Papierkorb ist leer.')}</div>
      ) : (
        <div className="card list">
          {items.map((i) => (
            <div key={i.path} className="list-item">
              <span className="grow">
                {i.title}
                <div className="small faint">{i.path}</div>
              </span>
              <span className="small faint">{relTime(i.deleted)}</span>
              {canWrite && (
                <button className="btn small" onClick={() => restore(i.path)}>
                  {tr('Wiederherstellen')}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {el}
    </div>
  )
}
