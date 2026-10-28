import { useState } from 'react'
import { api } from '../lib/api'
import { useApp } from '../lib/state'
import { Spinner } from '../lib/ui'
import { LlmCard } from './SettingsPage'
import { tr } from '../lib/i18n'

/** Einrichtung nach dem ersten Login (nur Admin): Welche Funktionen sollen an sein? */
export function SetupPage() {
  const { features, refreshMe, refreshVaults, toast } = useApp()
  const [example, setExample] = useState(false)
  const [curator, setCurator] = useState(features.curator)
  const [chat, setChat] = useState(features.chat)
  const [busy, setBusy] = useState(false)
  const [llmShown, setLlmShown] = useState(false)

  const save = async () => {
    setBusy(true)
    try {
      if (example) {
        await api('/vaults/example', { method: 'POST' }).catch((e) => toast((e as Error).message, 'error'))
        await refreshVaults()
      }
      await api('/system/features', { method: 'PUT', body: { curator, chat, setup_done: true } })
      await refreshMe()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const ai = curator || chat
  return (
    <div className="setup">
      <div className="setup-card card stack">
        <div className="row">
          <img src="/icon.svg" alt="" width={36} height={36} onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
          <div>
            <h1 style={{ margin: 0, fontSize: 22 }}>{tr('Willkommen bei BasaltNotes')}</h1>
            <div className="small muted">{tr('Was soll eingeschaltet sein? Alles lässt sich später unter Einstellungen → Funktionen ändern.')}</div>
          </div>
        </div>

        <label className="feature-toggle">
          <input type="checkbox" checked={curator} onChange={(e) => setCurator(e.target.checked)} />
          <div>
            <strong>{tr('KI-Kurator')}</strong>
            <div className="small muted">
              {tr('Sortiert eingehende Texte (Transkripte, Dokumente) automatisch in Personen, Orte, Aufgaben usw. ein, findet Duplikate und schlägt Änderungen vor. Braucht ein lokales LLM (Ollama). Menü: Eingang, Vorschläge, Kurator-Protokoll.')}
            </div>
          </div>
        </label>
        <label className="feature-toggle">
          <input type="checkbox" checked={chat} onChange={(e) => setChat(e.target.checked)} />
          <div>
            <strong>{tr('KI-Chat')}</strong>
            <div className="small muted">{tr('Fragen an die Notizen stellen („Was weiß ich über …?“). Braucht ebenfalls das LLM. Menü: Fragen.')}</div>
          </div>
        </label>

        <label className="feature-toggle">
          <input type="checkbox" checked={example} onChange={(e) => setExample(e.target.checked)} />
          <div>
            <strong>{tr('Beispiel-Vault anlegen')}</strong>
            <div className="small muted">{tr('Eine kleine, erfundene D&D-Kampagne („Die Nebelküste“) mit Sessions, NPCs, Orten und Quests – zum Ausprobieren von Links, Graph und Kampagnenseite. Lässt sich später einfach löschen.')}</div>
          </div>
        </label>

        {ai && !llmShown && (
          <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => setLlmShown(true)}>
            {tr('LLM-Server jetzt einstellen …')}
          </button>
        )}
        {ai && llmShown && <LlmCard onSaved={() => undefined} />}

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn primary" disabled={busy} onClick={() => void save()}>
            {busy ? <Spinner /> : tr('Fertig')}
          </button>
        </div>
      </div>
    </div>
  )
}
