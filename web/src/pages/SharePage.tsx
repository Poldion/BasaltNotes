import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api, enc } from '../lib/api'
import { useApp } from '../lib/state'
import { nativeApp, nativeShare } from '../lib/native'
import { tr } from '../lib/i18n'

/** Dateitypen, die der Eingang als Dokument versteht; alles andere wird Anhang */
const DOCUMENT = /\.(pdf|docx|txt|md|markdown)$/i

/** Aus anderen Apps Geteiltes in den Eingang eines Vaults legen (Android-App und installierte PWA) */
export function SharePage() {
  const { vaults, features, toast, refreshVaults } = useApp()
  const location = useLocation()
  const navigate = useNavigate()
  const shared = useMemo(() => {
    const native = nativeShare()
    if (native) return native
    const q = new URLSearchParams(location.search)
    return { title: q.get('title'), text: [q.get('text'), q.get('url')].filter(Boolean).join('\n') || null, files: [] }
  }, [location.search])
  const [vault, setVault] = useState(() => {
    try {
      return localStorage.getItem('basalt:share-vault') ?? ''
    } catch {
      return ''
    }
  })
  const [text, setText] = useState([shared.title, shared.text].filter((x, i, all) => x && all.indexOf(x) === i).join('\n\n'))
  const [curate, setCurate] = useState<'review' | 'auto' | 'none'>(features.curator ? 'review' : 'none')
  const [busy, setBusy] = useState(false)
  const target = vaults.some((v) => v.id === vault) ? vault : (vaults[0]?.id ?? '')

  useEffect(() => {
    document.title = tr('Teilen – BasaltNotes')
  }, [])

  const leave = (to: string) => {
    nativeApp?.clearShare()
    navigate(to, { replace: true })
  }

  const submit = async () => {
    setBusy(true)
    try {
      const base = `/vaults/${enc(target)}`
      let body = text.trim()
      for (const f of shared.files) {
        const blob = await (await fetch(f.url)).blob()
        const fd = new FormData()
        if (DOCUMENT.test(f.name)) {
          fd.append('curate', curate)
          fd.append('file', blob, f.name)
          await api(`${base}/inbox/upload`, { body: fd })
        } else {
          fd.append('file', blob, f.name)
          const r = await api<{ embed: string }>(`${base}/attachments`, { body: fd })
          body = body ? `${body}\n\n${r.embed}` : r.embed
        }
      }
      // Ohne Kurator direkt eine Notiz: Der Eingang allein würde den Text nur ablegen, ohne dass er im Vault auftaucht
      let created: string | null = null
      if (body && curate === 'none') {
        const line = (shared.title ?? body.split('\n')[0]).replace(/!?\[\[|\]\]|[\\/:*?"<>|#^]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
        const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-')
        const n = await api<{ id: string }>(`${base}/notes`, { body: { title: line || tr('Geteilt {date}', { date: stamp }), body: `${body}\n` } }).catch((e) => {
          if (e.status !== 409) throw e
          return api<{ id: string }>(`${base}/notes`, { body: { title: `${line} ${stamp}`, body: `${body}\n` } })
        })
        created = n.id
      } else if (body) await api(`${base}/inbox`, { body: { text: body, curate, source: { app: 'share' } } })
      try {
        localStorage.setItem('basalt:share-vault', target)
      } catch {
        // ignorieren
      }
      toast(tr('Eingeliefert'), 'success')
      void refreshVaults().catch(() => undefined)
      leave(created ? `/${target}/note/${enc(created)}` : features.curator ? `/${target}/inbox` : `/${target}`)
    } catch (e) {
      toast((e as Error).message, 'error')
      setBusy(false)
    }
  }

  if (!text && !shared.files.length && !busy) return <div className="page"><div className="empty">{tr('Nichts zu teilen.')}</div></div>

  return (
    <div className="page">
      <div className="page-header">
        <h1>{tr('In BasaltNotes teilen')}</h1>
      </div>
      <section className="card stack">
        <label className="field">
          <span>{tr('Vault')}</span>
          <select className="input" value={target} onChange={(e) => setVault(e.target.value)}>
            {vaults.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{tr('Text')}</span>
          <textarea className="input" rows={8} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        {shared.files.length > 0 && (
          <div className="small muted">
            {tr('Dateien:')} {shared.files.map((f) => f.name).join(', ')}
          </div>
        )}
        {features.curator && (
          <select className="input" value={curate} onChange={(e) => setCurate(e.target.value as any)} aria-label={tr('Kurator')}>
            <option value="review">{tr('Kurator: alles als Vorschlag')}</option>
            <option value="auto">{tr('Kurator: nach Regeln')}</option>
            <option value="none">{tr('Nur ablegen')}</option>
          </select>
        )}
        <div className="row">
          <span className="grow" />
          <button className="btn ghost" disabled={busy} onClick={() => leave('/')}>
            {tr('Abbrechen')}
          </button>
          <button className="btn primary" disabled={busy || !target} onClick={submit}>
            {tr('Einliefern')}
          </button>
        </div>
      </section>
    </div>
  )
}
