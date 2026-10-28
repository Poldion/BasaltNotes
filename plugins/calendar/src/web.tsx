import type { WebPluginContext } from '@basaltnotes/plugin-sdk/web'
import { useApp } from '@basaltnotes/plugin-sdk/web'
import { CalendarPage } from './CalendarPage.js'
import { tr } from '@basaltnotes/plugin-sdk/web'

/** Kalender-Apps und Home Assistant (CalDAV) – Karte unter Einstellungen */
function CalDavCard() {
  const { toast, isAdmin } = useApp()
  const url = `${location.origin}/dav/`
  return (
    <section className="card stack">
      <div className="card-title" style={{ marginBottom: 0 }}>
        {tr('Kalender-Apps & Home Assistant')}
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        {tr('Termine, Aufgaben und Listen (z. B. die Einkaufsliste) gibt es per CalDAV – für Home Assistant, das Handy (iOS, Android mit DAVx⁵) und Thunderbird. Abhaken und Hinzufügen landet direkt in den Notizen.')}
      </p>
      <div className="row">
        <input className="input mono grow" readOnly value={url} onFocus={(e) => e.target.select()} />
        <button className="btn small" onClick={() => void navigator.clipboard.writeText(url).then(() => toast(tr('Kopiert')))}>
          {tr('Kopieren')}
        </button>
      </div>
      <ol className="small" style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4 }}>
        <li>
          {isAdmin
            ? tr('Unter API-Tokens einen „Zugang für eine App“ anlegen: Notizbuch mit Terminen/Listen, lesen + schreiben.')
            : tr('Von einem Admin einen „Zugang für eine App“ anlegen lassen: Notizbuch mit Terminen/Listen, lesen + schreiben.')}
        </li>
        <li>
          {tr('Home Assistant: Einstellungen → Geräte & Dienste → Integration hinzufügen → CalDAV. Adresse wie oben, Benutzername beliebig (z. B. „ha“), Passwort = Token.')}
        </li>
        <li>{tr('Jedes Notizbuch erscheint als Kalender „… – Termine“, Aufgaben und jede Liste als eigene To-do-Liste.')}</li>
      </ol>
      <p className="small faint" style={{ margin: 0 }}>
        {tr('Notizen per Sprache oder Automation (')}<code>{tr('POST /api/v1/vaults/<vault>/capture')}</code>{tr(') und Dashboards: siehe docs/handbuch.md, Abschnitt „Home Assistant“.')}
      </p>
    </section>
  )
}

export default function activate(ctx: WebPluginContext) {
  ctx.registerPage({ path: 'calendar', component: CalendarPage })
  ctx.registerNav({ id: 'calendar', label: tr('Kalender'), icon: 'calendar', path: 'calendar', order: 10 })
  ctx.registerSettings({ id: 'caldav', component: CalDavCard })
}
