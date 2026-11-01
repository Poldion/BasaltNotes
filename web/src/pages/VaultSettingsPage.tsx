import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, enc } from '../lib/api'
import { invalidateTypes, useApp } from '../lib/state'
import { Spinner, useConfirm, usePrompt } from '../lib/ui'
import { TypesEditor } from '../components/TypesEditor'
import { tr } from '../lib/i18n'

export function VaultSettingsPage() {
  const { vault = '' } = useParams()
  const { toast, isVaultAdmin: isAdmin, canWrite, vaults, refreshVaults, features } = useApp()
  const navigate = useNavigate()
  const info = vaults.find((v) => v.id === vault)
  const [yaml, setYaml] = useState<string | null>(null)
  const [templates, setTemplates] = useState<{ name: string; content: string }[]>([])
  const [tpl, setTpl] = useState<string>('')
  const [tplContent, setTplContent] = useState('')
  const [busy, setBusy] = useState(false)
  const { confirm, el: confirmEl } = useConfirm()
  const { ask, el: promptEl } = usePrompt()

  useEffect(() => {
    if (isAdmin)
      api<{ yaml: string }>(`/vaults/${enc(vault)}/config`)
        .then((r) => setYaml(r.yaml))
        .catch(() => setYaml(''))
    api<{ items: { name: string; content: string }[] }>(`/vaults/${enc(vault)}/templates`)
      .then((r) => {
        setTemplates(r.items)
        if (r.items[0]) {
          setTpl(r.items[0].name)
          setTplContent(r.items[0].content)
        }
      })
      .catch(() => undefined)
  }, [vault, isAdmin])

  const saveYaml = async () => {
    try {
      const r = await api<{ yaml: string }>(`/vaults/${enc(vault)}/config`, { method: 'PUT', body: { yaml } })
      setYaml(r.yaml)
      invalidateTypes(vault)
      await refreshVaults()
      toast(tr('Einstellungen gespeichert'), 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  const saveTpl = async () => {
    try {
      await api(`/vaults/${enc(vault)}/templates/${enc(tpl)}`, { method: 'PUT', body: { content: tplContent } })
      setTemplates((ts) => ts.map((t) => (t.name === tpl ? { ...t, content: tplContent } : t)))
      toast(tr('Vorlage gespeichert'), 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  const newTpl = async () => {
    const name = await ask(tr('Neue Vorlage'), tr('Name (z. B. „npc“ für Typ npc)'), '')
    if (!name) return
    setTemplates((ts) => [...ts, { name, content: '# {{title}}\n\n' }])
    setTpl(name)
    setTplContent('# {{title}}\n\n')
  }
  const reindex = async () => {
    setBusy(true)
    try {
      const r = await api<{ notes: number; ms: number }>(`/vaults/${enc(vault)}/reindex`, { method: 'POST' })
      toast(tr('{notes} Notizen in {ms} ms neu indiziert', { notes: r.notes, ms: r.ms }), 'success')
    } finally {
      setBusy(false)
    }
  }
  const rename = async () => {
    const name = await ask(tr('Vault umbenennen'), tr('Anzeigename'), info?.name ?? '')
    if (!name) return
    await api(`/vaults/${enc(vault)}`, { method: 'PATCH', body: { name } })
    await refreshVaults()
  }
  const curatorMode = !info ? '' : !info.curator.enabled ? 'off' : info.curator.mode === 'link' ? 'link' : 'full'
  const setCuratorMode = async (m: string) => {
    try {
      await api(`/vaults/${enc(vault)}`, { method: 'PATCH', body: { curator: m === 'off' ? { enabled: false } : { enabled: true, mode: m } } })
      await refreshVaults()
      api<{ yaml: string }>(`/vaults/${enc(vault)}/config`).then((r) => setYaml(r.yaml)).catch(() => undefined)
      toast(tr('Kurator-Einstellung gespeichert'), 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  const remove = async () => {
    if (!(await confirm(<>{tr('Vault „{name}“ löschen? Der Ordner wird nach {path} verschoben.', { name: info?.name, path: 'data/deleted-vaults' })}</>, { yes: tr('Vault löschen'), danger: true }))) return
    await api(`/vaults/${enc(vault)}`, { method: 'DELETE' })
    await refreshVaults()
    navigate('/')
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>{tr('Vault: {name}', { name: info?.name })}</h1>
        {isAdmin && (
          <button className="btn small" onClick={rename}>
            {tr('Umbenennen')}
          </button>
        )}
        <a className="btn small" href={`/api/v1/vaults/${enc(vault)}/export.zip`}>
          {tr('Export (ZIP)')}
        </a>
        {canWrite && (
          <button className="btn small" onClick={reindex} disabled={busy}>
            {busy ? <Spinner /> : tr('Neu indizieren')}
          </button>
        )}
        {isAdmin && (
          <button className="btn small danger" onClick={remove}>
            {tr('Löschen')}
          </button>
        )}
      </div>

      <div className="stack">
        {isAdmin && info && (
          <section className="card stack">
            <div className="card-title" style={{ marginBottom: 0 }}>
              {tr('Kurator für diesen Vault')}
            </div>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {[
                ['off', tr('Aus'), tr('Eingang und Uploads werden nur abgelegt.')],
                ['link', tr('Nur verknüpfen'), tr('Erwähnungen vorhandener Notizen werden verlinkt – ohne KI, es wird nichts angelegt.')],
                ['full', tr('Einsortieren (KI)'), tr('Das LLM erkennt Personen, Orte, Aufgaben … und legt Notizen an oder ergänzt sie.')],
              ].map(([m, label, hint]) => (
                <label key={m} className="card" style={{ flex: '1 1 200px', padding: 10, cursor: 'pointer', borderColor: curatorMode === m ? 'var(--accent)' : undefined }}>
                  <div className="row" style={{ gap: 6 }}>
                    <input type="radio" name="curator-mode" checked={curatorMode === m} onChange={() => void setCuratorMode(m)} />
                    <strong>{label}</strong>
                  </div>
                  <div className="small muted">{hint}</div>
                </label>
              ))}
            </div>
            {!features.curator && curatorMode === 'full' && (
              <p className="small muted" style={{ margin: 0 }}>
                {tr('Der KI-Kurator ist unter Einstellungen → Funktionen ausgeschaltet – Eingang und Uploads werden deshalb nur abgelegt.')}
              </p>
            )}
            <p className="small muted" style={{ margin: 0 }}>
              {tr('„Erwähnungen verknüpfen“ im Menü einer Notiz geht unabhängig davon jederzeit.')}
            </p>
          </section>
        )}
        {isAdmin && <TypesEditor vault={vault} />}
        {isAdmin && (
          <section className="card stack">
            <div className="card-title" style={{ marginBottom: 0 }}>
              {tr('vault.yaml – Typen, Ordner, Kurator-Regeln')}
            </div>
            <p className="small muted" style={{ margin: 0 }}>
              <code>curator.auto_apply</code>{tr(': Operationen ohne Freigabe ·')}{' '}<code>curator.review</code>{tr(': immer als Vorschlag ·')}{' '}<code>min_confidence_auto</code>{tr(': darunter immer Vorschlag. Ordner-Platzhalter:')}{' '}<code>{'{campaign}'}</code>, <code>{'{title}'}</code>.
            </p>
            {yaml === null ? <Spinner /> : <textarea className="input mono" rows={22} value={yaml} onChange={(e) => setYaml(e.target.value)} spellCheck={false} />}
            <div className="row">
              <span className="grow" />
              <button className="btn primary" onClick={saveYaml}>
                {tr('Speichern')}
              </button>
            </div>
          </section>
        )}
        <section className="card stack">
          <div className="card-title" style={{ marginBottom: 0 }}>
            {tr('Vorlagen')}
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            {tr('Platzhalter:')}{' '}<code>{'{{title}}'}</code>, <code>{'{{date}}'}</code>, <code>{'{{campaign}}'}</code>, <code>{'{{type}}'}</code>{tr('. Abschnitte wie „Aus den Sessions“ nutzt der Kurator.')}
          </p>
          <div className="row">
            <select
              className="input"
              style={{ width: 'auto' }}
              value={tpl}
              onChange={(e) => {
                setTpl(e.target.value)
                setTplContent(templates.find((t) => t.name === e.target.value)?.content ?? '')
              }}
            >
              {templates.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
            {canWrite && (
              <button className="btn small" onClick={newTpl}>
                {tr('+ Vorlage')}
              </button>
            )}
          </div>
          {tpl && <textarea className="input mono" rows={10} value={tplContent} onChange={(e) => setTplContent(e.target.value)} readOnly={!canWrite} />}
          {canWrite && tpl && (
            <div className="row">
              <span className="grow" />
              <button className="btn primary" onClick={saveTpl}>
                {tr('Vorlage speichern')}
              </button>
            </div>
          )}
        </section>
      </div>
      {confirmEl}
      {promptEl}
    </div>
  )
}
