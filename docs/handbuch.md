# BasaltNotes – Handbuch

🇬🇧 [English](manual.md) · 🇩🇪 Deutsch

Selbst gehostete Notiz-App nach dem Vorbild von Obsidian – mit mehreren Vaults, `[[Wiki-Links]]`, Backlinks,
Eigenschaften, Volltextsuche und einem **KI-Kurator**, der neue Inhalte (z. B. Session-Recaps aus WhisperNotes)
selbstständig in den Bestand einsortiert: neue NPCs, Orte und Quests anlegen, bestehende ergänzen,
Schreibvarianten („Cydia“ → Zylia) als Alias lernen – und nichts still überschreiben.

Die Dateien sind die Wahrheit: Jeder Vault ist ein normaler Ordner mit Markdown-Dateien (und git-Verlauf)
und lässt sich parallel in Obsidian öffnen.

---

## Funktionen

| Bereich | Was es kann |
|---|---|
| **Notizen** | Markdown + YAML-Frontmatter, stabile IDs (ULID), Typen mit Ordnern, Vorlagen und Eigenschaften. D&D-Typen: Kampagne, Session, Skript (Vorbereitung), Charakter, NPC, Monster, Ort, Fraktion, Gegenstand, Quest, Lore, Fakten. Alltag: Notiz, Tagebuch, Aufgabe, Liste, Termin, Rezept, Idee, Lesezeichen, Anleitung, Besprechung, Person, Projekt – plus **eigene Typen** mit Feldern, Ordner und Vorlage (Vault-Einstellungen → Typen) |
| **Freie Vaults** | Vault-Art „Frei“: nur der Typ „Notiz“, Ordner frei wählbar, Eigenschaften frei, neue Notiz = Titel + Ordner. Datumsfelder im Kopf (`start`, `date`, `due`) erscheinen im Kalender |
| **Verknüpfen** | „Erwähnungen verknüpfen“ im Notiz-Menü: macht die erste Erwähnung anderer Notizen (Titel, Aliasse) zum Link – mit Vorschau, ohne KI. Als Kurator-Modus „Nur verknüpfen“ läuft das auch automatisch für den Eingang, selbst wenn die KI ausgeschaltet ist |
| **Plugins** | Eigene Erweiterungen mit Server- und Oberflächen-Teil (Seiten, Menüpunkte, Einstellungen, Endpunkte); Kalender & CalDAV sind ein mitgeliefertes Plugin |
| **Home Assistant** | Kalender und To-do-Listen per CalDAV (Plugin „Kalender & CalDAV“) (auch Handy/Thunderbird; Listen-Punkte abhaken und hinzufügen landet in der Notiz), Notizen per Sprache/Automation, Notizen fürs Dashboard |
| **Kalender** (Plugin) | Monats- und Listenansicht je Notizbuch oder über alle: Termine (auch ganztägig, mehrtägig, wiederkehrend), fällige Aufgaben zum Abhaken, Sessions, Besprechungen, Vorbereitungen und eigene Typen mit Datumsfeld |
| **Alltag** | „Heute“ öffnet den Tagebuch-Eintrag des Tages, Checklisten (`- [ ]`) lassen sich in der Leseansicht abhaken – z. B. Einkaufs- und Packlisten |
| **Editor** | CodeMirror 6 mit Live-Vorschau, `[[`-Autovervollständigung inkl. Aliasse, Bilder einfügen/ziehen, Autosave, Konflikterkennung |
| **Verknüpfung** | Backlinks mit Kontext, ausgehende Links, nicht aufgelöste Links legen per Klick die Notiz an, Umbenennen passt alle Links an |
| **Suche** | Volltext (SQLite FTS5) mit Treffer-Ausschnitten, Filter nach Typ/Kampagne/Tag/Eigenschaft, Schnellöffner <kbd>Strg</kbd>+<kbd>O</kbd>, Dataview-ähnliche Abfragen |
| **Verlauf** | git-Commit pro Speichern (gebündelt) und pro Kurator-Lauf, Diff und Wiederherstellen je Notiz, Papierkorb, ZIP-Export |
| **Fragen** | Chat mit den Notizen: passende Einträge werden ohne LLM vorausgewählt (Namen, Tippfehler, Übersichten, Erwähnungen, Volltext), das Modell bekommt nur diese – gebaut für kleine lokale Modelle |
| **KI optional** | Kurator und Chat sind bei einer neuen Einrichtung aus – einschalten im Einrichtungsschritt nach dem ersten Login oder unter Einstellungen → Funktionen; erst dann erscheinen Eingang, Vorschläge, Kurator-Protokoll und Fragen im Menü |
| **KI-Kurator** | Erkennen → Abgleichen → Planen → Anwenden/Vorschlagen; Regeln je Vault; Trockenlauf; Fortschrittsanzeige mit Stopp-Knopf; „Lauf rückgängig“ |
| **Dokumente** | PDF, Word, Text und Markdown in den Eingang hochladen: Text wird ausgelesen, Original als Anhang abgelegt, der Kurator sortiert ein |
| **Vorbereitung** | Typ „Skript (Vorbereitung)“ für Pre-Game-Skripte: eigener Ordner, Vorlage mit Szenen und Geheimnissen, Status geplant/gespielt/verworfen, nur für den DM; auf der Kampagnenseite unter „Vorbereitung“ |
| **Benutzer** | Mehrere Konten (Admin, Mitglied mit Rechten je Notizbuch, Spieler), Sperren, Passwort-Reset |
| **Kampagnen** | Startseite mit „Was bisher geschah“, Timeline, offene Quests, Charaktere, zuletzt geänderte Einträge, Spieler-Sicht |
| **Einbindung** | REST-API, OpenAPI, Server-Sent Events, Webhooks (HMAC-signiert), iframe-Einbettungen mit `postMessage`, JS-SDK |
| **Oberfläche** | Deutsch und Englisch (Umschalter DE/EN unten in der Seitenleiste), Hell/Dunkel, bis Handybreite, installierbar als PWA (Offline-Lesen), Graph-Ansicht |

---

## Installation auf TrueNAS SCALE

Das fertige Image liegt auf Docker Hub: **`poldion/basaltnotes`**.

1. **Dataset für die Vaults anlegen:** *Datasets → Add Dataset*, Name `BasaltVaults` (Preset „Generic“ oder „Apps“).
   Rechte musst du nicht setzen – der Container übernimmt das beim Start.
2. **Apps → Discover Apps → ⋮ → Install via YAML** und den Inhalt von
   [`docker-compose.yml`](../docker-compose.yml) einfügen. Anpassen:
   - `./vaults` durch den Pfad des Datasets ersetzen, z. B. `/mnt/Storage/BasaltVaults` (Pool `Storage`)
   - `ADMIN_PASSWORD` – Passwort für den ersten Benutzer `admin` (nur beim ersten Start)
   - `LLM_URL` – Adresse von Ollama bzw. des Ollama-Proxys (nur für die KI-Funktionen; Zeile einkommentieren)
   - ggf. den Port (`4400:8080` → `HOST:8080`)
3. Starten und `http://<nas>:4400` öffnen, als `admin` anmelden.
   Ohne `ADMIN_PASSWORD` wird ein Passwort erzeugt und einmalig im App-Log ausgegeben.
4. Unter **Einstellungen → Benutzer** weitere Konten anlegen, unter **API-Tokens** Tokens für andere Apps.

**Speicher:**

| Was | Wo | Inhalt |
|---|---|---|
| App-Daten | Docker-Volume `basaltnotes-data` → `/data` (legt TrueNAS automatisch an) | `config.yaml`, `index.sqlite` (Benutzer, Tokens, Eingang, Kurator-Protokoll, Suchindex) |
| Vaults | Dataset `BasaltVaults` → `/data/vaults` (direkt gemountet) | je Vault ein Ordner mit Markdown-Dateien, Anhängen und git-Verlauf |

Der Container startet kurz als root, setzt die Besitzrechte von `/data` (inkl. Vaults) auf `PUID:PGID`
(Standard `568:568` = TrueNAS-Benutzer „apps“) und läuft dann ohne root-Rechte weiter.

Mit Docker Compose an anderer Stelle genauso: `docker compose up -d`.

### Update

Image neu ziehen und App neu starten (TrueNAS: „Update“ bzw. `docker compose pull && docker compose up -d`).
Daten und Index bleiben im Volume, der Index wird bei Bedarf automatisch neu aufgebaut.

---

## Konfiguration

Umgebungsvariablen haben Vorrang vor `/data/config.yaml`.

| Variable | Standard | Bedeutung |
|---|---|---|
| `ADMIN_PASSWORD` | – | Passwort des ersten Benutzers (nur wenn noch kein Benutzer existiert) |
| `ADMIN_USER` | `admin` | Name des ersten Benutzers |
| `create_vault` | Vaults anlegen. Der anlegende Token hat im neuen Vault alle Rechte, und nur dort (bis zu 20 eigene Vaults) |
| `ADMIN_PASSWORD_RESET` | `false` | `true`: setzt das Passwort von `ADMIN_USER` beim Start auf `ADMIN_PASSWORD` (Notfall) |
| `FEATURE_CURATOR` / `FEATURE_CHAT` | `false` | KI-Kurator bzw. KI-Chat beim **ersten** Start einschalten. Danach gilt der Schalter unter Einstellungen → Funktionen (gespeichert in `config.yaml`). Bestehende Installationen, die den Kurator schon benutzen, behalten ihn beim Update |
| `LLM_URL` | `http://localhost:11434` | Ollama bzw. Ollama-Proxy für Kurator und Chat (im Container meist `http://<ollama-host>:11434`); lässt sich auch unter Einstellungen → „LLM-Server und Modell“ ändern |
| `LLM_MODEL` | – | leer = aktuell geladenes Modell (`/api/ps`, sonst `/api/tags`) |
| `LLM_NUM_CTX` | – | leer = automatisch: `/api/ps` → Proxy `/admin/state` (`forced_options.num_ctx`) → 4096 |
| `LLM_TIMEOUT_MS` | `600000` | Höchstens so lange auf das **erste** Token warten (Einlesen, ggf. Warten hinter anderen Anfragen) |
| `LLM_IDLE_TIMEOUT_MS` | `120000` | Höchstens so lange **ohne neues Token**. Antworten werden gestreamt – langsame Modelle dürfen beliebig lange schreiben, solange sie liefern |
| `LLM_THINK_CHAT` / `LLM_THINK_CURATOR` | `off` | Nachdenken (Thinking) im Chat bzw. beim Kurator: `off`, `on`, `low`, `medium`, `high` (Stufen nur bei gpt-oss, sonst wie `on`). Modelle ohne Thinking schalten automatisch zurück auf aus |
| `LLM_CHAT_CONTEXT_CHARS` | `6000` | Höchstens so viele Zeichen Notizen gehen pro Chat-Frage an das LLM (zusätzlich begrenzt durch den Kontext des Modells). Kleiner = schneller |
| `CORS_ORIGINS` | – | Kommagetrennte Ursprünge, die per Browser auf die API dürfen (z. B. das DM-Panel) |
| `EMBED_ORIGINS` | = `CORS_ORIGINS` | Ursprünge, die BasaltNotes als iframe einbetten dürfen |
| `AUTH_HEADER` | – | Anmeldung über Reverse-Proxy, z. B. `Remote-User` (Authelia/Authentik). **Nur setzen, wenn der Container ausschließlich über den Proxy erreichbar ist.** Der Benutzer muss in BasaltNotes existieren. |
| `SESSION_TTL_HOURS` | `720` | Gültigkeit einer Anmeldung |
| `PUID` / `PGID` | `568` / `568` | Benutzer/Gruppe, unter dem die App läuft und dem die Dateien gehören |
| `UMASK` | `002` | Rechte neu angelegter Dateien |
| `PORT` / `DATA_DIR` | `8080` / `/data` | |
| `COMMIT_DELAY_MS` | `5000` | Speichervorgänge werden so lange zu einem git-Commit gebündelt |
| `WATCH_FILES` | `true` | Änderungen von außen (SMB, Obsidian) erkennen |
| `LOG_LEVEL` / `LOG_REQUESTS` | `info` / `false` | Protokollierung |

> **Adresse, Modell, Kontextgröße und Nachdenken lassen sich auch in der Oberfläche ändern** (Einstellungen → *LLM-Server und Modell*,
> nur Admins): „Verbindung testen“ listet die installierten Modelle, Speichern gilt sofort für Kurator und Chat, ohne
> Neustart. Die Werte landen als `llm_override` in `/data/config.yaml` und haben **Vorrang** vor `LLM_URL`/`LLM_MODEL`/
> `LLM_NUM_CTX`; „Auf Compose-Werte zurücksetzen“ entfernt sie wieder.


### Ablage im Volume

```
/data
├─ config.yaml            # Einstellungen (Secret, LLM, …)
├─ index.sqlite           # Index, Benutzer, Tokens, Eingang, Läufe, Vorschläge
└─ vaults/
   ├─ dnd/                # Vault „DnD“ – normaler Markdown-Ordner
   │  ├─ .basalt/vault.yaml      # Typen, Ordner, Kurator-Regeln
   │  ├─ .basalt/templates/      # Vorlagen je Typ
   │  ├─ .git/                   # Verlauf
   │  ├─ _inbox/ _attachments/ .trash/
   │  └─ Fluch des Strahd/NPCs/Zylia.md …
   └─ notizen/
```

**Backup:** Das Dataset `BasaltVaults` samt git ist das Backup der Notizen (dazu TrueNAS-Snapshots).
`index.sqlite` im App-Volume enthält außerdem Benutzer, Tokens und das Kurator-Protokoll – das Volume liegt im
Apps-Pool und wird von dessen Snapshots erfasst.

---

## Benutzer und Rollen

| Rolle | Darf |
|---|---|
| **Administration** | alles, inkl. Benutzer, Tokens, Webhooks, Vault-Einstellungen |
| **Mitglied** | je Notizbuch eine Rechte-Stufe wie bei Tokens (siehe „Freigaben je Notizbuch“), optional nur ein Bereich |
| **Spieler** | nur Notizen und Bereiche mit `visibility: players`, optional nur eine Kampagne; kein Eingang/Kurator |

Die älteren Rollen **Bearbeiten** (`editor`) und **Lesen** (`viewer`) laufen weiter und werden beim Bearbeiten zu Mitgliedern
mit derselben Stufe. Konten mit Administration und Spieler lassen sich auf einzelne Vaults beschränken. Gesperrte Konten und Konten mit geänderten Rechten
werden sofort abgemeldet. Der letzte Admin kann weder gelöscht noch herabgestuft werden.
Passwörter werden mit Argon2 gespeichert, Tokens nur als Hash.

---

## KI-Kurator

```
Eingang → 1 Erkennen → 2 Abgleichen → 3 Planen → 4 Anwenden/Vorschlagen → Protokoll + git-Commit
```

- **Erkennen:** Das LLM bekommt den Text und die bekannten Namen/Aliasse der Kampagne und antwortet nach
  festem JSON-Schema (Ollama `format`). Lange Texte werden in Abschnitte von etwa vier Seiten geteilt; die Antwort
  wird gestreamt, die Oberfläche zeigt Abschnitt und erzeugte Tokens.
- **Dauer:** Bestimmt vor allem die Antwortgeschwindigkeit des Modells. Bei ~8 Tokens/s etwa 1–4 Minuten je Abschnitt,
  plus 10–20 s je unsicherem Namen.
- **Verknüpfen:** Das LLM liefert auch Beziehungen (Questgeber, Ziel einer Quest, Aufenthaltsort, Fraktion, Besitzer,
  „liegt in“, Verbündete, Feinde). Beide Notizen bekommen einen Abschnitt „Beziehungen“ mit Links in beide Richtungen
  (z. B. Quest „Ziel: [[Muffgallerte]]“ ↔ Monster „Ziel von: [[Beseitigung des Gestanks]]“). Passende Eigenschaften
  (`giver`, `location`, `faction`, `owner`, `parent`) werden bei neuen Einträgen direkt gesetzt, bei bestehenden nur
  vorgeschlagen und nur, wenn das Feld leer ist.
- **Duplikate vermeiden:** Einträge ohne Kampagne gelten kampagnenübergreifend; Kurzformen werden dem vollen Namen
  zugeordnet („Fyrn“ → „Fyrn Linstök“, Artikel zählen nicht: „Die Eber Jagd“ = „Eberjagd“); existiert ein Eintrag mit
  gleichem Titel und Typ, wird er ergänzt statt „Name 2“ anzulegen.
- **Duplikate suchen:** Knopf auf der Vorschlags-Seite (ohne LLM, Sekunden). Findet gleiche Titel, Titel = Alias,
  Kurzform/voller Name, ähnliche Schreibweisen und gleiche Titel mit anderem Typ und legt Zusammenführ-Vorschläge an.
  Abgelehnte Paare werden nicht erneut vorgeschlagen. Beim Zusammenführen wandern Kurator-Beiträge als Bereiche mit,
  fehlende Eigenschaften werden übernommen, Links umgebogen.
- **Räume:** Räume und Bereiche innerhalb eines Ortes (z. B. „Raum A“ eines Dungeons) werden keine eigenen Notizen,
  sondern Unterabschnitte unter „Räume“ im übergeordneten Ort. Beziehungen verlinken direkt auf den Raum
  (`[[Die uralten Tunnel#Raum C – …]]`).
- **Abgleichen:** exakter Treffer über Titel/Alias → sonst Kandidaten über Jaro-Winkler, Levenshtein und
  Kölner Phonetik → bei Zweifel entscheidet das LLM.
- **Planen:** `create_entity`, `append_block`, `add_mention`, `add_alias` laufen standardmäßig automatisch;
  `update_property`, `contradiction`, `merge_entities`, `update_quest`, `delete` werden **immer** Vorschläge.
  Alles unter `min_confidence_auto` wird Vorschlag. Einstellbar in `vault.yaml`.
- **Sicherheit:** Der Kurator schreibt nur in **verwaltete Bereiche**
  (`<!-- basalt:block key="…" -->…<!-- /basalt:block -->`). Eigener Text bleibt byte-genau erhalten.
  Gleiche Quelle → Bereiche werden **ersetzt**, nicht verdoppelt. DM-Wissen landet in Bereichen mit
  `visibility="dm"`.
- **Rückgängig:** per git-Revert; wurden die Notizen seitdem bearbeitet, werden nur die Beiträge des Laufs
  zurückgenommen.
- **Kurator-Modi je Vault** (Vault-Einstellungen): *Aus*, *Nur verknüpfen* (Erwähnungen vorhandener Notizen werden
  zu Links, ohne LLM, es wird nichts angelegt – geht auch bei ausgeschalteter KI) und *Einsortieren (KI)*.

---

## Fragen an die Notizen (Chat)

Unter **Fragen** in der Seitenleiste (oder im Notizmenü **⋯ → Fragen zu dieser Notiz**) lässt sich mit den
Notizen chatten. Damit auch kleine Modelle gute Antworten geben, sucht BasaltNotes **vorher ohne LLM** heraus, was
zur Frage gehört, und schickt nur das – höchstens `LLM_CHAT_CONTEXT_CHARS` Zeichen:

1. **Hauptthemen:** Titel und Aliasse in der Frage – auch gebeugt („Kefirs“), als Teilname („Fyrn“ für
   „Fyrn Linstök“) oder mit Tippfehler („Muffelgallerte“). Bei Rückfragen („Und wo wohnt er?“) gilt das Thema der
   vorigen Antwort weiter. Vom Hauptthema geht der Inhalt mit Eigenschaften mit; lange Einträge werden auf die
   Abschnitte gekürzt, in denen die Begriffe der Frage vorkommen.
2. **Erwähnungen:** die Textstellen anderer Einträge (Sessions und Skripte zuerst), die auf das Hauptthema verlinken.
3. **Verknüpft:** direkt verlinkte Einträge als Einzeiler (Ort, Questgeber, …).
4. **Übersichten:** „Welche Quests sind offen?“, „Welche NPCs gibt es?“ → Liste des Typs, ggf. nach Status gefiltert.
5. **Stand und Verlauf:** „Was ist der aktuelle Stand?“, „Was ist zuletzt passiert?“, „Wo ist die Gruppe gerade?“ →
   Zeitlinie der Sessions in der Reihenfolge, in der sie angelegt bzw. hochgeladen wurden,
   die **neueste Session ausführlich** (Abschnitte wie „Ereignisse“ und „Offene Handlungsstränge“ zuerst), dazu das
   Ende von Chroniken. Vorbereitete Skripte erscheinen nur als Liste, weil sie nicht unbedingt gespielt sind.
6. **Volltext:** Einträge, in denen Begriffe der Frage vorkommen, wenn noch Platz ist.

Rückfragen ohne eigenes Thema („Nee, die sind schon abgereist“) werden zusammen mit der vorigen Frage ausgewertet.

Findet sich nichts, antwortet BasaltNotes direkt, ohne das LLM zu fragen. Unter jeder Antwort stehen die Quellen und
auf Wunsch genau der Text, den das LLM bekommen hat. Spieler-Konten sehen nur, was für Spieler freigegeben ist
(ohne DM-Bereiche und Abschnitte mit „(DM)“ in der Überschrift). Läuft gerade der Kurator, kommt die Frage nach dem
aktuellen Arbeitsschritt dran.

---

## Plugins

BasaltNotes lässt sich mit Plugins erweitern. Der **Kalender samt CalDAV** ist selbst ein Plugin
(mitgeliefert, eingeschaltet) und dient als Beispiel: [`plugins/calendar`](../plugins/calendar).
Ein- und ausschalten: Einstellungen → Plugins (wirkt sofort, die Seite lädt neu).

**D&D** ist ebenfalls ein mitgeliefertes Plugin: Kampagnen, Spieler-Sicht und Spieler-Konten, die D&D-Vorlage, die Regeln des
Kurators und der Beispiel-Vault. Auf einer neuen Installation ist es aus. Solange ein Vault die Vorlage `dnd` benutzt, ist es
automatisch an, bestehende Vaults laufen also ohne Zutun weiter. Schaltet man es aus, bleiben Notizen und Typen erhalten und
bestehende Spieler-Konten weiter eingeschränkt; nur die Kampagnenseiten und neue D&D-Vaults und Spieler-Konten fallen weg.

### Katalog: Plugins installieren und aktualisieren

Einstellungen → Plugins → **Katalog** zeigt die Plugins aller eingetragenen Repos, ähnlich wie HACS bei Home Assistant.
Voreingestellt ist das offizielle Repo [`Poldion/BasaltNotes-Plug`](https://github.com/Poldion/BasaltNotes-Plug). Unter **Repos**
lassen sich beliebige GitHub-Repos ergänzen. Neue Versionen erscheinen als Update unter **Installiert**.

- Das darf nur, wer den Server verwaltet.
- Plugins nur mit Oberfläche wirken nach dem automatischen Neuladen der Seite, Plugins mit Server-Teil erst nach einem Neustart des Servers (die Oberfläche weist darauf hin).
- Pakete werden **nicht geprüft oder signiert**. Plugins laufen mit allen Rechten des Servers – installiere nur aus Quellen, denen du vertraust.

Aufbau eines eigenen Repos: siehe [README des Plugin-Repos](https://github.com/Poldion/BasaltNotes-Plug#readme).

**Aufbau** – ein Ordner mit `manifest.json`:

```json
{
  "id": "mein-plugin",
  "name": "Mein Plugin",
  "version": "1.0.0",
  "description": "Was es tut",
  "server": "dist/server.js",
  "web": "dist/web.js",
  "styles": "dist/web.css",
  "default_enabled": false,
  "http_methods": []
}
```

Eigene Plugins kommen nach `/data/plugins/<id>/` (Neustart des Containers lädt sie); mitgelieferte liegen im
Programm. Ein eigenes Plugin kann ein mitgeliefertes nicht ersetzen (gleiche `id` wird ignoriert).

**Server-Teil** (`server`, ESM): exportiert `{ api?(app, ctx), root?(app, ctx) }`.

- `api` – Endpunkte unter `/api/v1`. Anmeldung, CSRF, Rechte und Freigaben gelten wie im Kern.
- `root` – Endpunkte ab `/` (z. B. `/dav`), mit eigener Anmeldung (`ctx.helpers.authenticateToken`).
- `ctx` bietet: `db` (lesend wie schreibend auf den Index), `vaults` (Notizen lesen/anlegen/ändern),
  `helpers` (`vaultFor`, `noteFor`, `requireScope`, `accessOf`, `restrictSql`, `restrictionAllows`,
  `assertInArea`, `listTasks`/`setTask`/`appendTask`, `json`, `stripLink`, `error` …), `settings` (eigene
  Einstellungen in `config.yaml`), `allowArea(method, url, 'read'|'write')` (Endpunkt für Zugänge mit
  Bereichs-Einschränkung freigeben) und `log`.
- Ausgeschaltete Plugins antworten automatisch mit 404, ohne Neustart.

**Oberfläche** (`web`, ESM im Browser): exportiert `default function activate(ctx)` mit
`ctx.registerPage({ path, scope: 'vault'|'global', component })` (Seite unter `/<vault>/<path>` bzw. `/p/<path>`),
`ctx.registerNav({ id, label, icon, path, order })` (Seitenleiste) und `ctx.registerSettings({ id, component })`
(Karte unter Einstellungen). React, `react-router-dom` und `@basaltnotes/plugin-sdk/web` (`api`, `useApp`,
`useTypes`, `useVaultEvents`, `Modal`, `Spinner`, `TypeDot` …) stellt die App bereit – nicht mitbündeln.

**Bauen:** Typen und Build-Hilfe liegen in [`packages/plugin-sdk`](../packages/plugin-sdk):

```js
// build.mjs
import { buildPlugin } from '@basaltnotes/plugin-sdk/build'
await buildPlugin({ root: import.meta.dirname, server: 'src/server.ts', web: 'src/web.tsx', styles: 'src/web.css' })
```

**Weitere Erweiterungspunkte:** Das Server-Modul kann außerdem `presets` (Vorlagen für neue Vaults), `profiles` (Regeln für Kurator,
Eingang und Chat) und `roles` (Rollen für Konten) mitbringen, das Oberflächen-Modul mit `registerHomeSection` Abschnitte auf der
Startseite eines Notizbuchs. Vollständiges Beispiel: [`plugins/dnd`](../plugins/dnd).

Plugins laufen mit den Rechten der App (Server) bzw. der angemeldeten Person (Oberfläche) – nur Plugins
installieren, denen man vertraut.

| Methode | Pfad | Scope | Zweck |
|---|---|---|---|
| GET | `/plugins` | angemeldet | Installierte Plugins `{id, name, version, description, builtin, enabled, error, web, styles}` |
| PUT | `/plugins/{id}` | Server-Admin | Ein-/ausschalten `{enabled}` |
| GET | `/plugins/catalog` | Server-Admin | Katalog aller Repos mit installiertem Stand und Updates (`?refresh=1`) |
| POST | `/plugins/install` | Server-Admin | Aus dem Katalog installieren oder aktualisieren `{id}` |
| DELETE | `/plugins/{id}` | Server-Admin | Installiertes Plugin entfernen |
| POST / DELETE | `/plugins/repos` | Server-Admin | Eigenes GitHub-Repo eintragen oder austragen `{url}` |
| GET | `/presets` | angemeldet | Vorlagen für neue Vaults (Kern und eingeschaltete Plugins) |
| GET | `/plugins/{id}/<datei>` (ohne `/api/v1`) | – | Oberflächen-Dateien (nur aus dem Ordner von `web`/`styles`) |

---

## Android-App

Die App in [`android/`](../android) zeigt die Oberfläche deines Servers, hat also denselben Funktionsumfang und alle eingeschalteten
Plugins. Beim ersten Start gibst du die Server-Adresse ein (http im Heimnetz und eigene, auf dem Gerät installierte
Zertifizierungsstellen gehen auch), danach meldest du dich wie gewohnt an. Wechseln: Einstellungen → Android-App.

- **Teilen:** Texte, Links und Dateien aus anderen Apps an BasaltNotes teilen. Mit Kurator landen sie im Eingang, ohne Kurator wird aus Text direkt eine Notiz.
- **Touch:** Leiste über der Tastatur (Formatieren, Wiki-Link öffnen, Datei anhängen, Suchen, Rückgängig), ⋮ im Dateibaum für Umbenennen, Verschieben und Löschen, im Graph mit zwei Fingern zoomen.
- **Updates:** Einmal am Tag fragt die App bei den GitHub-Releases nach einer neuen Version und bietet sie zur Installation an (auch von Hand: Einstellungen → Android-App). Das ist die einzige Verbindung außer zu deinem Server. Die erste Installation kommt als APK vom [Release](https://github.com/Poldion/BasaltNotes/releases).
- **Offline-Lesen** geht nur über https, das ist eine Vorgabe von Android.
- Die App braucht einen Server ab der Version, die sie mitbringt. Ältere Server laufen ohne Teilen und ohne Downloads aus der App.

Bauen: siehe [`android/README.md`](../android/README.md).

## Integration

### WhisperNotes → Eingang

```http
POST /api/v1/vaults/dnd/inbox
Authorization: Bearer <token mit Rechten „Nur Eingang“ + „Lesen“>
Idempotency-Key: whispernotes:job:ab12cd34:v3

{
  "source": { "app": "whispernotes", "key": "whispernotes:job:ab12cd34", "url": "http://…" },
  "note": { "type": "session", "title": "2026-10-11 Session 1",
            "frontmatter": { "campaign": "Fluch des Strahd", "date": "2026-10-11T22:00:00+02:00", "players": [ … ] },
            "body": "## Was bisher geschah\n…" },
  "attachments": [ { "name": "Welt & Lore", "kind": "lore", "markdown": "…", "visibility": "dm" } ],
  "curate": "auto"
}
```

Antwort `202 {inbox_id, status, note_id}`. Die Session-Notiz wird sofort angelegt, der Kurator läuft im
Hintergrund. Gleiche `source.key` → Beiträge werden ersetzt. Whisper-Glossar:
`GET /api/v1/vaults/dnd/names?campaign=…&types=npc,location,character` (Feld `glossary`).

### Home Assistant

**1. Zugang anlegen:** Einstellungen → API-Tokens → neuer Token, z. B. „Home Assistant“: Notizbuch
„Notizen“ mit *lesen + schreiben* (für D&D-Termine optional „DnD“ mit *nur lesen*). Das Token in
`secrets.yaml` ablegen:

```yaml
basalt_token: "Bearer bn_…"
```

**2. Kalender und To-do-Listen (CalDAV, Plugin „Kalender & CalDAV“ muss eingeschaltet sein):** *Einstellungen → Geräte & Dienste → Integration hinzufügen → CalDAV*

| Feld | Wert |
|---|---|
| URL | `http://nas.local:4400/dav/` |
| Benutzername | beliebig, z. B. `ha` |
| Passwort | das Token (ohne „Bearer“) |

Danach gibt es je Notizbuch einen Kalender `calendar.<notizbuch>_termine` (Termine, Sessions, fällige Einträge –
Typ „Termin“ ist auch aus Home Assistant bearbeitbar) und To-do-Listen: „<Notizbuch> – Aufgaben“ (Notizen vom Typ
Aufgabe) und **je Liste eine eigene To-do-Liste** (z. B. `todo.einkauf`). Abhaken, Hinzufügen und Löschen in Home
Assistant ändert direkt die Checkliste in der Notiz. Damit funktioniert auch Assist von Haus aus:
„Füge Milch zu Einkauf hinzu“.

Dieselbe Adresse funktioniert in Thunderbird, auf iOS (Einstellungen → Kalender → Accounts → CalDAV) und unter
Android mit DAVx⁵. Hinweise: Wiederholungen verstehen BasaltNotes und die Apps als täglich, wöchentlich, monatlich
oder jährlich (bis zu einem Enddatum) – komplexere Regeln (z. B. „jeden 2. Dienstag“) aus anderen Apps werden als
einfache Wiederholung gespeichert. Uhrzeiten gelten in der Zeitzone `TZ` des Containers (Standard `Europe/Berlin`).

**3. Notizen per Sprache oder Automation:** `POST /api/v1/vaults/{vault}/capture` legt Text ab – ohne Ziel als Zeile
mit Uhrzeit im heutigen Tagebuch, mit `"list": "Einkauf"` als Punkt auf einer Liste, mit `"to": "note"` als neue
Notiz.

```yaml
# configuration.yaml
rest_command:
  basalt_notiz:
    url: "http://nas.local:4400/api/v1/vaults/notizen/capture"
    method: POST
    headers:
      Authorization: !secret basalt_token
    content_type: "application/json; charset=utf-8"
    payload: '{"text": {{ text | tojson }}}'

intent_script:
  BasaltNotiz:
    action:
      - action: rest_command.basalt_notiz
        data:
          text: "{{ text }}"
    speech:
      text: "Notiert."
```

```yaml
# custom_sentences/de/basalt.yaml – „Notiere Heizung entlüftet“
language: "de"
intents:
  BasaltNotiz:
    data:
      - sentences:
          - "notiere {text}"
          - "schreib ins tagebuch {text}"
lists:
  text:
    wildcard: true
```

In Automationen genauso, z. B. beim Verlassen des Hauses: `action: rest_command.basalt_notiz` mit
`data: { text: "Haus verlassen, Fenster zu" }`.

**4. Notizen auf dem Dashboard:** `?clean=1` liefert den Text ohne Frontmatter und ohne `[[ ]]`.

```yaml
# configuration.yaml
rest:
  - resource: "http://nas.local:4400/api/v1/vaults/notizen/notes/by-title?title=Wochenplan&fields=title,body&clean=1"
    headers:
      Authorization: !secret basalt_token
    scan_interval: 300
    sensor:
      - name: "Wochenplan"
        value_template: "{{ value_json.title }}"
        json_attributes:
          - body
```

Markdown-Karte im Dashboard: `content: "{{ state_attr('sensor.wochenplan', 'body') }}"`. Termine zeigt die normale
Kalender-Karte mit `calendar.notizen_termine`, Listen die To-do-Karte.

### DM-Panel

- Kampagnen-Startseite in einem Aufruf: `GET /api/v1/vaults/dnd/campaigns/{kampagne}/overview?visibility=dm|players`
- Wiki im eigenen Layout: `GET …/notes/{id}/html?link_base=/wiki/{vault}/{id}` + `…/backlinks`
- Bearbeiten im Panel: iframe `/embed/dnd/note/{id}?mode=edit&links=parent&theme=dark`
- Vorschläge prüfen: iframe `/embed/dnd/proposals?campaign=…`
- Live: `GET /api/v1/events?vault=dnd` (SSE) oder Webhooks (`X-Basalt-Signature: sha256=HMAC(secret, body)`)

`postMessage` der Einbettungen: `basalt:ready`, `basalt:navigate {noteId, title, noteType}`, `basalt:resize {height}`,
`basalt:saved {noteId, version}`; an die Einbettung: `basalt:open {noteId}`, `basalt:setTheme {theme}`, `basalt:search {q}`.

### JS-SDK

[`packages/client`](../packages/client) (`@basaltnotes/client`):

```ts
import { BasaltNotes } from '@basaltnotes/client'
const b = new BasaltNotes({ baseUrl: 'https://notes.home', token })
const overview = await b.campaigns.overview('dnd', 'fluch-des-strahd')
const html = await b.notes.html('dnd', noteId, { linkBase: '/wiki/{vault}/{id}' })
b.events.on('inbox.processed', (e) => toast(`${e.data.created} neue Einträge`), { vault: 'dnd' })
```

Alle Endpunkte stehen in der [API-Referenz](#api-referenz).

---

## API-Referenz

Basis-URL: `http://<host>:4400/api/v1` · JSON (UTF-8) · Zeitstempel ISO-8601 mit Zeitzone.
Die maschinenlesbare Beschreibung (OpenAPI 3) liefert der Server unter **`GET /api/v1/openapi.json`**.

### Grundlagen

#### Anmeldung

| Weg | Verwendung |
|---|---|
| `Authorization: Bearer <token>` | Andere Apps (WhisperNotes, DM-Panel, Skripte). Tokens legt ein Admin unter *Einstellungen → API-Tokens* an. |
| `?token=<token>` | Wo keine Header möglich sind: `EventSource`, Bilder, iframe-Einbettungen |
| Session-Cookie `basalt_session` | Web-Oberfläche. Schreibende Aufrufe brauchen zusätzlich `X-CSRF-Token` (aus Login bzw. `/auth/me`). |
| Proxy-Header (`AUTH_HEADER`) | Optional, z. B. `Remote-User` von Authelia/Authentik |

Ohne Anmeldung erreichbar: `GET /health`, `POST /auth/login`, `GET /openapi.json`.

#### Rechte (Scopes)

| Scope | Erlaubt |
|---|---|
| `read` | Lesen (in `write` und `curate` enthalten) |
| `write` | Notizen, Ordner, Bereiche, Anhänge, Vorlagen schreiben (enthält `inbox`) |
| `inbox` | Nur in den Eingang einliefern |
| `curate` | Kurator: Vorschläge annehmen/ablehnen, Läufe rückgängig machen, Notizen kuratieren |
| `admin` | Alles, inkl. Benutzer, Tokens, Webhooks, Vault-Einstellungen |

Tokens und Benutzer können auf einzelne Vaults beschränkt sein. Tokens/Konten mit Spieler-Sicht
(`visibility: players`) sehen nur Notizen und Bereiche mit `visibility: players` und haben keinen Zugriff
auf Eingang, Vorschläge und Kurator-Läufe. Rollen der Benutzerkonten: `admin` (alle Scopes),
`editor` (`read`, `write`, `inbox`, `curate`), `viewer` (`read`), `player` (`read` + Spieler-Sicht). Sichtbarkeit (`visibility`) gibt es nur in D&D-Vaults.

Andere Projekte können so ein eigenes Vault bekommen: Token mit `{"name": "MeineApp", "scopes": ["create_vault"]}` anlegen, die App ruft dann
`POST /vaults` mit `{"name": "MeineApp"}` auf (`409` = Name vergeben, vorher `GET /vaults` prüfen). Die App sieht nur ihre eigenen Vaults, außer sie
hat weitere Rechte oder Freigaben. Wird das Vault gelöscht, endet die Zuordnung.

#### Fehlerformat

```json
{ "error": { "code": "version_conflict", "message": "Die Notiz wurde inzwischen geändert.", "details": { "current_version": "sha1:…" } } }
```

`message` ist standardmäßig deutsch und mit `X-Basalt-Lang: en` oder `Accept-Language: en` englisch; maßgeblich ist `code`.

| Code | HTTP | Bedeutung |
|---|---|---|
| `validation_error` | 400 | Ungültige Eingabe (z. B. fehlender Titel, fehlendes `If-Match`) |
| `unauthorized` | 401 | Nicht angemeldet, Token ungültig/abgelaufen, Konto gesperrt |
| `forbidden` | 403 | Fehlender Scope, kein Zugriff auf den Vault, CSRF-Token fehlt |
| `not_found` | 404 | Vault, Notiz, Version, Vorschlag … nicht gefunden |
| `version_conflict` | 409 | `If-Match` passt nicht – `details.current_version` und `details.current` enthalten den aktuellen Stand |
| `conflict` | 409 | Sonstiger Konflikt (Name vergeben, Lauf schon rückgängig, letzter Admin …) |
| `rate_limited` | 429 | Zu viele Anfragen (Login: 10/min, sonst 1200/min je IP) |
| `llm_unavailable` | 503 | LLM nicht erreichbar |

#### Versionen, Idempotenz, Seiten

- **Version/ETag:** Jede Notiz hat `version` (`sha1:…` des Dateiinhalts), auch als `ETag`-Header.
  `PUT` braucht `If-Match: "<version>"` (`*` = ohne Prüfung). `PATCH` prüft nur, wenn `If-Match` gesetzt ist.
  Verwaltete Bereiche (`/blocks`) brauchen kein `If-Match`.
- **Idempotenz:** `POST` mit Header `Idempotency-Key: <schlüssel>` liefert bei Wiederholung dieselbe Antwort
  (Header `Idempotent-Replayed: true`), 7 Tage lang.
- **Seiten:** Listen akzeptieren `limit` (Standard 50, max. 500) und `cursor`; die Antwort enthält `next_cursor`
  (`null` = Ende).
- **Sichtbarkeit:** Viele Lese-Endpunkte akzeptieren `?visibility=players` und filtern dann DM-Inhalte heraus.
- **CORS:** Nur Ursprünge aus `CORS_ORIGINS`; keine Wildcard.

---

### System & Anmeldung

| Methode | Pfad | Scope | Zweck |
|---|---|---|---|
| GET | `/health` | – | Status, Version, Notizen je Vault, LLM (erreichbar, Modell, Kontextgröße und Quelle), Warteschlange. `?refresh=1` prüft das LLM neu |
| GET | `/openapi.json` | – | OpenAPI-Beschreibung |
| GET | `/system/features` | angemeldet | Eingeschaltete Funktionen `{curator, chat, setup_done}` (auch in `/auth/me`) |
| PUT | `/system/features` | admin | Funktionen schalten `{curator?, chat?, setup_done?}` – gilt sofort. Ausgeschaltet antworten Kurator- (Vorschläge, Läufe, Kurator-Status, Notiz kuratieren) bzw. Chat-Endpunkte mit 403; der Eingang nimmt weiter an und legt nur ab |
| GET | `/system/llm` | admin | LLM-Einstellungen `{url, model, num_ctx, override, env}` |
| GET | `/system/llm/models` | admin | Installierte Modelle eines Servers (`?url=` zum Testen vor dem Speichern) → `{models: [{name, parameter_size, quantization, size, loaded}]}` |
| PUT | `/system/llm` | admin | `{url?, model?, num_ctx?, think_chat?, think_curator?}` speichern (gilt sofort, Vorrang vor Umgebungsvariablen); `{"reset": true}` entfernt die eigenen Werte |
| POST | `/auth/login` | – | `{username, password}` → setzt Cookie, liefert `{user, csrf, expires}` |
| POST | `/auth/logout` | angemeldet | Abmelden |
| GET | `/auth/me` | angemeldet | `{kind, name, user_id, display_name, role, vaults, scopes, visibility, campaign, csrf, embed_origins, roles}` |
| POST | `/auth/password` | Benutzerkonto | Eigenes Passwort ändern `{current, new}` (andere Sitzungen werden beendet) |

### Benutzer

| Methode | Pfad | Scope | Zweck |
|---|---|---|---|
| GET | `/users` | admin | Alle Benutzer + verfügbare Rollen |
| POST | `/users` | admin | Anlegen `{username, password, role, grants? (Rolle `member`), vaults?, campaign?, display_name?}` |
| PATCH | `/users/{id}` | admin | Ändern: `role`, `grants`, `vaults`, `campaign`, `display_name`, `disabled`, `password` (Reset) |
| DELETE | `/users/{id}` | admin | Löschen (nicht das eigene Konto, nicht den letzten Admin) |

`vaults` ist `"*"` oder eine Liste von Vault-IDs. Benutzername: 2–63 Zeichen (`a-z 0-9 . _ @ -`),
Passwort mindestens 8 Zeichen.

### Tokens

| Methode | Pfad | Scope | Zweck |
|---|---|---|---|
| GET | `/tokens` | admin | Tokens (ohne Geheimnis) mit „zuletzt benutzt“ |
| POST | `/tokens` | admin | `{name, grants: [Freigabe], scopes?: ["create_vault"], expires?}` · weiterhin möglich, klassisch: `{name, scopes, vaults?, expires?, visibility?: "players", campaign?}` → `{token, …}` – **das Token wird nur einmal angezeigt** |
| PATCH | `/tokens/{id}` | admin | Freigaben ändern `{grants}` – der Token-Wert bleibt gleich |
| POST | `/tokens/embed` | `read`/`write` im Vault | Kurzlebiges Token für Einbettungen `{vault, scope?: "read"\|"write", ttl? (s, Standard 3600, max. 7 Tage), visibility?, campaign?}` |
| DELETE | `/tokens/{id}` | admin | Widerrufen |

Beispiel WhisperNotes: `{"name": "WhisperNotes", "grants": [{"vault": "dnd", "access": "read_inbox"}, {"vault": "notizen", "access": "read_inbox"}]}`.

**Freigaben je Notizbuch** (Einstellungen → API-Tokens): Jede Freigabe nennt ein Notizbuch (`*` = alle) und eine Rechte-Stufe.

| Stufe (`access`) | Rechte |
|---|---|
| `read` | Lesen |
| `inbox` | Nur in den Eingang geben |
| `read_inbox` | Lesen + Eingang |
| `curate` | Lesen + Eingang + Kurator |
| `write` | Lesen + Schreiben + Eingang |
| `write_curate` | Schreiben + Kurator |
| `admin` | Alles im Notizbuch, auch dessen Einstellungen |

Server verwalten (Benutzer, Tokens, Webhooks) darf nur `admin` für `*`. Änderungen gehen jederzeit über *Rechte* bzw.
`PATCH /tokens/{id}` mit `{name?, grants?, create_vault?, expires?}`; der Token-Wert bleibt gleich. Klassisch angelegte Tokens
laufen unverändert weiter und erscheinen genauso. Lesen, Eingang und Schreiben lassen sich zusätzlich auf einen **Bereich** beschränken:

```json
{
  "name": "D&D-Tool",
  "grants": [
    { "vault": "dnd", "access": "read", "campaign": "Regarion", "types": ["lore", "npc", "location"] },
    { "vault": "notizen", "access": "write", "folders": ["Rezepte"] }
  ]
}
```

| Feld | Bedeutung |
|---|---|
| `campaign` | Nur Einträge dieser Kampagne. `shared` (Standard `true`) nimmt Einträge **ohne** Kampagne dazu (allgemeine Welt/Regeln) |
| `types` | Nur diese Typen (z. B. `lore`, `npc`) |
| `folders` | Nur Einträge in diesen Ordnern (inkl. Unterordner) |

Ein Zugang mit Bereich sieht in Liste, Suche, Abfrage, Namen, Graph, Kampagnen und Chat nur passende Einträge; Notizen
außerhalb sind „nicht gefunden“, Links darauf werden nicht aufgelöst. Schreiben legt neue Notizen im Bereich an (Kampagne
wird gesetzt, Ordner gewählt) und verweigert Änderungen, die eine Notiz aus dem Bereich schieben. Funktionen, die
Inhalte außerhalb zeigen oder ändern könnten (Verlauf, Papierkorb, Export, Eingang, Kurator, Anhänge, Ordner, Tags,
Live-Ereignisse), sind für solche Zugänge gesperrt. Kurator- und Verwaltungsrechte gehen nur ohne Bereich.

### Vaults

| Methode | Pfad | Scope | Zweck |
|---|---|---|---|
| GET | `/vaults` | angemeldet | Vaults (gefiltert nach Zugriff) mit `note_count`, `types`, `open_proposals`, `inbox_pending` |
| POST | `/vaults` | admin | Anlegen `{name, preset: "dnd" \| "notes" \| "empty", lang?: "de" \| "en"}` – `empty` = frei (nur „Notiz“, Kurator „nur verknüpfen“); `lang` bestimmt die Sprache der Ordnernamen der Vorlage (Standard: Sprache der Anfrage) |
| POST | `/vaults/example` | admin | Beispiel-Vault „Beispiel – Die Nebelküste“ (erfundene D&D-Kampagne) anlegen; 409, wenn es ihn schon gibt |
| GET | `/vaults/{vault}` | read | Details inkl. Kurator-Einstellungen |
| PATCH | `/vaults/{vault}` | admin | `{name?, curator?: {enabled, mode: "full" \| "link", auto_apply, review, min_confidence_auto, learn_aliases, section}}` – `mode: link` = nur Erwähnungen verlinken (ohne LLM) |
| DELETE | `/vaults/{vault}` | admin | Löschen (Ordner wird nach `data/deleted-vaults` verschoben) |
| GET | `/vaults/{vault}/types` | read | Typen mit Ordner, Vorlage und Eigenschafts-Schema (für dynamische Formulare); `builtin` = mitgeliefert |
| GET | `/vaults/{vault}/types/{name}` | read | Ein Typ mit `template_body` (Vorlage) und `note_count` |
| PUT | `/vaults/{vault}/types/{name}` | admin | Typ anlegen/ändern `{label, folder, properties: [{name, label, type, options?, link_types?}], template_body?}` – `type`: `text`, `number`, `date`, `datetime`, `boolean`, `select`, `list`, `link`, `url`. Ordner-Platzhalter `{year}`, `{month}`, `{campaign}`, `{title}` |
| DELETE | `/vaults/{vault}/types/{name}` | admin | Typ entfernen (nur ohne Notizen dieses Typs) |
| POST | `/vaults/{vault}/reindex` | write | Index aus den Dateien neu aufbauen → `{notes, ms}` |
| GET / PUT | `/vaults/{vault}/config` | admin | `vault.yaml` lesen / ersetzen `{yaml}` |
| GET | `/vaults/{vault}/tree` | read | `{folders, notes: [{id, path, title, type}]}` für Dateibäume |
| POST | `/vaults/{vault}/folders` | write | Ordner anlegen `{path}` |
| PATCH | `/vaults/{vault}/folders` | write | Ordner umbenennen/verschieben `{from, to}` |
| DELETE | `/vaults/{vault}/folders?path=…` | write | Ordner löschen (Notizen → Papierkorb) |
| GET | `/vaults/{vault}/trash` | read | Papierkorb |
| POST | `/vaults/{vault}/trash/restore` | write | Wiederherstellen `{path}` |
| DELETE | `/vaults/{vault}/trash` | admin | Papierkorb leeren (Stände bleiben in git) |
| GET | `/vaults/{vault}/templates` | read | Vorlagen `{name, content}` |
| PUT / DELETE | `/vaults/{vault}/templates/{name}` | write | Vorlage speichern `{content}` / löschen. Platzhalter: `{{title}}`, `{{date}}`, `{{campaign}}`, `{{type}}` |
| GET | `/vaults/{vault}/export.zip` | read | Vault als ZIP |

### Notizen

| Methode | Pfad | Scope | Zweck |
|---|---|---|---|
| GET | `/vaults/{vault}/calendar` | read | Kalender (Plugin „Kalender & CalDAV“) `?from=JJJJ-MM-TT&to=JJJJ-MM-TT` (Standard: −7 bis +42 Tage, höchstens 400 Tage) → `{items: [{id, note_id, vault, title, type, start, end, all_day, location, done, status, recurrence, field}]}`. Quelle ist das erste Datumsfeld eines Typs: `start` (+`end`, `all_day`, `recurrence`: täglich/wöchentlich/monatlich/jährlich, `until`), `date`, `due` (Aufgaben, `done` aus `status`), `planned_for`. Zeiten sind Ortszeit (`YYYY-MM-DDTHH:mm`), Wiederholungen sind aufgelöst |
| GET | `/calendar` | angemeldet | Dasselbe über alle zugänglichen Notizbücher (`?vaults=a,b` zum Eingrenzen) |
| POST | `/vaults/{vault}/capture` | write | Text schnell ablegen `{text, to?: "journal"\|"list"\|"note", list?, title?, heading?}` – Standard: Zeile mit Uhrzeit im heutigen Tagebuch; mit `list` als Punkt auf der Liste mit diesem Titel |
| POST | `/vaults/{vault}/journal/today` | write | Tagebuch-Eintrag für heute (oder `{date: "YYYY-MM-DD"}`) – wird angelegt, falls nötig → Notiz + `created` |
| GET | `/vaults/{vault}/notes/{id}/tasks` | read | Aufgaben der Notiz (`- [ ] …`) → `{items: [{index, checked, text}], version}` |
| POST | `/vaults/{vault}/notes/{id}/link` | write | Erwähnungen vorhandener Notizen verlinken (ohne LLM) `{dry_run?, links?: [Titel]}` → `{linked, diff, note?}`; je Ziel nur die erste Erwähnung, Code/Links/Überschriften bleiben unberührt |
| POST | `/vaults/{vault}/notes/{id}/tasks/{index}` | write | Aufgabe abhaken/zurücksetzen `{checked, text?}` – ändert nur das Häkchen (und den Änderungszeitpunkt); passt `text` nicht mehr, gibt es 409 |
| GET | `/vaults/{vault}/notes` | read | Liste. Filter: `type` (auch kommagetrennt), `tag`, `campaign`, `folder`, `prop.<name>=<wert>`, `q`, `updated_since`, `sort` (z. B. `-updated,title`), `fields` (z. B. `title,type,status`), `limit`, `cursor` |
| GET | `/vaults/{vault}/notes/{id}` | read | Notiz. `?format=json` (Standard) \| `markdown` \| `html`; `?fields=…`; `?clean=1`: Text ohne Frontmatter, Bereichs-Markierungen und `[[ ]]` (z. B. für Dashboards; auch bei `by-title`) |
| GET | `/vaults/{vault}/notes/by-path?path=…` | read | Über Pfad finden |
| GET | `/vaults/{vault}/notes/by-title?title=…` | read | Über Titel, Dateiname oder Alias (`&type=`, `&campaign=` optional) |
| POST | `/vaults/{vault}/notes` | write | Anlegen `{title, type?, frontmatter?, body?, folder?, template?}` → `201` |
| PUT | `/vaults/{vault}/notes/{id}` | write | Ersetzen, **`If-Match` nötig**. Body `{raw}` (ganze Datei) oder `{frontmatter, body}` |
| PATCH | `/vaults/{vault}/notes/{id}` | write | `{frontmatter?: {…zusammenführen}, remove?: ["feld"], append?: "Text" \| {text, heading}}` |
| DELETE | `/vaults/{vault}/notes/{id}` | write | In den Papierkorb |
| POST | `/vaults/{vault}/notes/{id}/rename` | write | `{title?, folder?}` – ID bleibt, alle Links im Vault werden angepasst → `{…note, updated_links, updated_notes}` |
| GET | `/vaults/{vault}/notes/{id}/backlinks` | read | Eingehende Links `{source_id, source_title, source_type, text, heading, context, line}` |
| GET | `/vaults/{vault}/notes/{id}/links` | read | Ausgehende Links `{target, target_id, resolved, heading, embed}` |
| GET | `/vaults/{vault}/notes/{id}/history` | read | Versionen aus git `{rev, date, author, message}` |
| GET | `/vaults/{vault}/notes/{id}/history/{rev}` | read | Inhalt einer Version; `?diff=1` als Unified-Diff zur aktuellen |
| POST | `/vaults/{vault}/notes/{id}/restore` | write | Version wiederherstellen `{rev}` |
| POST | `/vaults/{vault}/notes/{id}/curate` | curate | Notiz durch den Kurator schicken. `?dry_run=1` → Plan mit Diffs (synchron), sonst `202 {job_id}`; `?mode=review` = alles als Vorschlag |

**Antwort `GET /notes/{id}`:**

```json
{
  "id": "01JA8Z6K3P8Q2V9W4X5Y6Z7A8B",
  "vault": "dnd",
  "path": "Fluch des Strahd/NPCs/Zylia.md",
  "type": "npc",
  "title": "Zylia",
  "aliases": ["Cydia", "Sylvia"],
  "tags": ["karawane"],
  "campaign": "Fluch des Strahd",
  "visibility": "players",
  "frontmatter": { "campaign": "Fluch des Strahd", "role": "Karawanenführerin", "status": "lebendig", "visibility": "players" },
  "body": "# Zylia\n\nEigener Text …",
  "raw": "---\nid: 01JA…\n---\n# Zylia …",
  "blocks": [{ "key": "whispernotes:job:ab12cd34", "source_note": "[[2026-10-11 Session 1]]", "visibility": null, "updated": "2026-10-12T01:40" }],
  "links": [{ "target_id": "01JB…", "text": "Barovia", "target": "Barovia", "heading": null, "embed": false, "resolved": true, "type": "location" }],
  "backlink_count": 4,
  "version": "sha1:9f2c…",
  "created": "2026-10-12T01:40:00+02:00",
  "updated": "2026-10-12T01:40:00+02:00"
}
```

`frontmatter` enthält alle Eigenschaften außer `id`, `type`, `title`, `aliases`, `created`, `updated`.
`raw` fehlt in der Spieler-Sicht.

**Ändern mit Konfliktschutz:**

```http
PUT /api/v1/vaults/dnd/notes/01JA8Z…
If-Match: "sha1:9f2c…"
Content-Type: application/json

{ "raw": "---\ntype: npc\ntitle: Zylia\n---\n# Zylia\n\nNeuer Text\n" }
```

→ `200` mit neuer `version`, oder `409 version_conflict` mit dem aktuellen Stand in `details.current`.

### Verwaltete Bereiche

Maschinen schreiben in markierte Abschnitte, eigener Text außerhalb bleibt byte-genau erhalten:

```markdown
## Aus den Sessions
<!-- basalt:block key="whispernotes:job:ab12cd34" source="[[2026-10-11 Session 1]]" updated="2026-10-12T01:40" -->
- Führt die Karawane.
<!-- /basalt:block -->
```

| Methode | Pfad | Scope | Zweck |
|---|---|---|---|
| PUT | `/vaults/{vault}/notes/{id}/blocks/{key}` | write | Setzen/ersetzen `{content, heading?, source_note?, visibility?: "dm"}`. Gleicher `key` ersetzt, neuer `key` hängt unter `heading` an (Überschrift wird bei Bedarf angelegt) |
| DELETE | `/vaults/{vault}/notes/{id}/blocks/{key}` | write | Bereich entfernen |
| DELETE | `/vaults/{vault}/blocks?key=…` | write | Alle Bereiche dieses Schlüssels im Vault entfernen; `&prefix=1` inkl. `key:…`-Unterschlüssel |

`key` URL-kodiert übergeben (`whispernotes%3Ajob%3Aab12cd34`). `source_note` darf eine Notiz-ID oder ein Titel sein.

### Suche, Abfragen, Namen

| Methode | Pfad | Scope | Zweck |
|---|---|---|---|
| GET | `/vaults/{vault}/search?q=…` | read | Volltext (Präfixsuche, alle Wörter) mit `highlights` (`<mark>…</mark>`) und `title_highlight`. Filter: `type`, `campaign`, `tag`, `limit`, `cursor` |
| POST | `/vaults/{vault}/query` | read | Strukturierte Abfrage (siehe unten) |
| GET | `/vaults/{vault}/resolve?name=…` | read | Kandidaten mit `score` 0–1 und `match` (`exact`, `similar`, `alias_similar`, `fulltext`); `&type=`, `&campaign=` |
| GET | `/vaults/{vault}/names` | read | Alle Titel + Aliasse: `{items: [{id, name, type, campaign, aliases}], glossary: [...]}`. `?campaign=…&types=npc,location` |
| GET | `/vaults/{vault}/tags` | read | `[{tag, count}]` |
| GET | `/vaults/{vault}/graph` | read | `{nodes: [{id, title, type, campaign, degree}], edges: [{source, target}]}`; `?campaign=`, `?type=` |
| POST | `/vaults/{vault}/render` | read | Beliebiges Markdown im Kontext des Vaults zu bereinigtem HTML `{markdown, link_base?}` |

**Abfrage:**

```json
POST /api/v1/vaults/dnd/query
{
  "where": [
    { "field": "type", "op": "=", "value": "npc" },
    { "field": "campaign", "op": "=", "value": "Fluch des Strahd" },
    { "field": "attitude", "op": "in", "value": ["feindlich", "neutral"] }
  ],
  "sort": [{ "field": "updated", "dir": "desc" }],
  "select": ["title", "role", "faction", "status", "updated"],
  "limit": 100
}
```

→ `{items: [{id, title, role, …}], total, next_cursor}`.
Felder: `id`, `type`, `title`, `campaign`, `path`, `visibility`, `created`, `updated`, `tag` sowie jede Eigenschaft
aus dem Frontmatter. Operatoren: `=`, `!=`, `in`, `not_in`, `contains`, `exists`, `not_exists`, `>`, `<`, `>=`, `<=`
(Vergleiche ohne Groß-/Kleinschreibung; Link-Werte wie `[[Barovia]]` werden als `Barovia` verglichen).
Zusätzlich `q` für Volltext.

### Chat

| Methode | Pfad | Scope | Beschreibung |
|---|---|---|---|
| POST | `/vaults/{vault}/chat` | read | Frage beantworten → `{answer, llm, sources, focus, chars, budget}` |
| POST | `/vaults/{vault}/chat/context` | read | Nur die Vorauswahl ohne LLM → `{focus, sources, text, chars, budget, list_types}` |

Body: `{"question": "Wer ist Kefir?", "history": [{role, content}], "previous": ["<focus der letzten Antwort>"], "focus": ["<Notiz-ID>"], "campaign": "Regarion", "stream": false, "include_context": false}`.
Mit `"stream": true` kommt die Antwort als Server-Sent Events: `context` (Quellen), `start` (LLM liest ein),
`thinking` (`{text}`, nur mit eingeschaltetem Nachdenken), `token` (`{text}`), `done` (`{answer, llm}`) bzw. `error`. `sources[].role`: `focus`, `mention`, `related`, `list`, `fulltext`.

### Eingang (Inbox)

| Methode | Pfad | Scope | Zweck |
|---|---|---|---|
| POST | `/vaults/{vault}/inbox` | inbox | Einliefern → `202 {inbox_id, status, note_id, note_path}` |
| POST | `/vaults/{vault}/inbox/upload` | inbox | Dokument hochladen (multipart, siehe unten) → `202 {inbox_id, status, note_id, note_path}` |
| GET | `/vaults/{vault}/inbox` | read | Liste; `?status=queued,running,processed,stored,error,cancelled,discarded` |
| GET | `/vaults/{vault}/inbox/{id}` | read | Status, Notiz, Ergebnis `{run_id, created, updated, proposals}`, Lauf, Vorschläge, Rohdaten |
| POST | `/vaults/{vault}/inbox/{id}/cancel` | curate | Verarbeitung abbrechen (wartend → sofort, laufend → vor dem Schreiben); Status danach `cancelled` |
| POST | `/vaults/{vault}/inbox/{id}/reprocess` | curate | Erneut verarbeiten (ersetzt Beiträge derselben Quelle); optional `{curate: "auto" \| "review"}` |
| DELETE | `/vaults/{vault}/inbox/{id}` | curate | Verwerfen |

```json
POST /api/v1/vaults/dnd/inbox
Idempotency-Key: whispernotes:job:ab12cd34:v3
{
  "source": { "app": "whispernotes", "key": "whispernotes:job:ab12cd34", "url": "http://whispernotes.local:8000/dashboard/#dnd" },
  "note": {
    "type": "session",
    "title": "2026-10-11 Session 1",
    "frontmatter": {
      "campaign": "Fluch des Strahd",
      "date": "2026-10-11T22:00:00+02:00",
      "players": [{ "player": "Robin", "character": null, "role": "dm" }, { "player": "Mara", "character": "Lyssara" }],
      "transcript_url": "http://whispernotes.local:8000/api/jobs/ab12cd34/transcript?format=md"
    },
    "body": "## Was bisher geschah\n…\n## Ereignisse\n…"
  },
  "attachments": [
    { "name": "Spieler-Recaps", "kind": "players_recap", "markdown": "## Lyssara (Mara)\n…" },
    { "name": "Welt & Lore", "kind": "lore", "markdown": "## NPCs\n…", "visibility": "dm" }
  ],
  "curate": "auto"
}
```

- `curate`: `auto` (Regeln aus `vault.yaml`), `review` (alles als Vorschlag), `none` (nur ablegen).
- Die Notiz wird **sofort** angelegt bzw. bei gleicher `source.key` aktualisiert (Titeländerung = Umbenennen).
  `body` und `attachments` landen als verwaltete Bereiche in der Notiz, eigener Text darin bleibt erhalten.
- Kampagne wird per Name zugeordnet (Groß-/Kleinschreibung egal) und bei Bedarf als Notiz angelegt;
  Sessions ohne `number` werden durchnummeriert.
- Ohne `note` geht auch reiner Text: `{"text": "Gruppe hat den Schlüssel verkauft", "campaign": "…", "curate": "review"}`.

**Dokumente hochladen** (`multipart/form-data`):

| Feld | Pflicht | Bedeutung |
|---|---|---|
| `file` | ja | `.pdf`, `.docx`, `.txt`, `.md` (max. 50 MB) |
| `campaign` | – | Kampagne (wird bei Bedarf angelegt) |
| `title` | – | Titel der Notiz (Standard: Dateiname) |
| `type` | – | Notiztyp (Standard: `script` – Skript (Vorbereitung) – im D&D-Vault, sonst `note`) |
| `visibility` | – | Nur D&D-Vault: `dm` (Standard) oder `players`. Im Notizen-Vault gibt es keine Sichtbarkeit. |
| `curate` | – | `auto` (Standard), `review`, `none` |

```sh
curl -X POST "$API/vaults/dnd/inbox/upload" -H "Authorization: Bearer $TOKEN" \
  -F "file=@Fluch des Strahd.pdf" -F "campaign=Fluch des Strahd" -F "curate=review"
```

- Das Original landet in `_attachments/`, die Notiz enthält `![[datei.pdf]]` und den ausgelesenen Text
  (bei PDFs mit `## Seite N`-Überschriften) als verwalteten Bereich – damit ist alles durchsuchbar.
- Bei `visibility: dm` und bei Skripten behandelt der Kurator alles Erkannte als DM-Wissen: neue NPCs, Orte und
  Quests werden mit `visibility: dm` angelegt und erscheinen nicht in der Spieler-Sicht.
- Bei Skripten weiß der Kurator, dass die Ereignisse geplant und noch nicht geschehen sind.
- Lange Dokumente werden in Abschnitte geteilt und nacheinander ausgewertet; schlägt ein Abschnitt fehl, wird er
  übersprungen und im Kurator-Lauf vermerkt.
- Dieselbe Datei erneut hochladen aktualisiert dieselbe Notiz (Erkennung über den Inhalt).
- Eingescannte PDFs ohne Textebene werden abgelehnt (keine Texterkennung/OCR).

### Vorschläge und Kurator-Läufe

| Methode | Pfad | Scope | Zweck |
|---|---|---|---|
| GET | `/vaults/{vault}/proposals` | read | `?status=open` (Standard) \| `accepted` \| `rejected` \| `superseded` \| `discarded` \| `all`, `&campaign=`, `&run_id=`, `&diff=1` |
| GET | `/vaults/{vault}/proposals/{id}` | read | Vorschlag mit `operation`, `reason`, `confidence` und `diff` (unified) |
| PATCH | `/vaults/{vault}/proposals/{id}` | curate | Vor dem Annehmen anpassen: `to`, `title`, `alias`, `field`, `frontmatter`, `type`, `note_id`, `other_id`, `block: {content}` |
| POST | `/vaults/{vault}/proposals/{id}/accept` | curate | Annehmen (wird angewendet und committet) |
| POST | `/vaults/{vault}/proposals/{id}/reject` | curate | Ablehnen |
| POST | `/vaults/{vault}/proposals/bulk` | curate | `{ids: [...], action: "accept" \| "reject"}` |
| GET | `/vaults/{vault}/curator/status` | read | Was der Kurator gerade tut: `{running: [{run_id, inbox_id, title, dry_run, phase, step, steps, started}], queued}` |
| POST | `/vaults/{vault}/curator/duplicates` | curate | **Duplikate suchen** ohne LLM → Zusammenführ-Vorschläge `{found, known, created, pairs}`; `?dry_run=1` nur auflisten, `?min_score=0.85` |
| POST | `/vaults/{vault}/curator/stop` | curate | **Kurator stoppen:** laufenden Lauf abbrechen, Warteschlange leeren → `{stopped_running, cancelled_queued}` |
| GET | `/vaults/{vault}/runs` | read | Läufe mit Status, Commit, Anzahl Änderungen/Vorschläge, Modell |
| GET | `/vaults/{vault}/runs/{id}` | read | Eingabe, Erkennung (`extraction` inkl. `resolutions`), Plan, angewendete Operationen, Vorschläge |
| POST | `/vaults/{vault}/runs/{id}/revert` | curate | Rückgängig → `{revert_commit, method: "git" \| "semantic", discarded_proposals}` |

Ein Abschnitt, bei dem das LLM zu lange gar nichts liefert oder dessen Antwort abgeschnitten wird, wird übersprungen
(im Lauf unter `llm.warnings` vermerkt); solche Fehler werden nicht automatisch wiederholt. Nur wenn das LLM nicht
erreichbar ist, versucht BasaltNotes es später erneut.

Abbrechen geschieht immer **vor** dem Schreiben: Die laufende LLM-Anfrage wird getrennt, der Lauf bekommt den Status
`cancelled`, im Vault ändert sich nichts. Ist ein Lauf schon beim Anwenden (wenige Sekunden), wird er noch fertig.
Abgebrochene Eingangseinträge lassen sich mit `reprocess` erneut verarbeiten.

Operationen (`operation.op`): `create_entity`, `append_block`, `add_mention`, `add_alias` (standardmäßig automatisch),
`update_property`, `contradiction`, `merge_entities`, `update_quest`, `delete` (immer Vorschlag).

### Kampagnen (für das DM-Panel)

| Methode | Pfad | Scope | Zweck |
|---|---|---|---|
| GET | `/vaults/{vault}/campaigns` | read | Kampagnen `{id, title, slug, status, system, players}` |
| GET | `/vaults/{vault}/campaigns/{kampagne}/overview` | read | Alles für eine Startseite (siehe unten); `?visibility=dm\|players` |
| GET | `/vaults/{vault}/campaigns/{kampagne}/timeline` | read | Sessions chronologisch `{id, title, number, date, transcript_url, recap_excerpt}` |

`{kampagne}` darf ID, Titel oder Kurzform sein (`fluch-des-strahd`).

```json
{
  "campaign": { "id": "…", "title": "Fluch des Strahd", "slug": "fluch-des-strahd", "status": "aktiv", "system": "5e", "players": [], "dm": null },
  "last_session": { "id": "…", "title": "2026-10-11 Session 1", "number": 1, "date": "…", "recap_excerpt": "Die Gruppe …" },
  "sessions": [{ "id": "…", "number": 1, "date": "…", "title": "…" }],
  "open_quests": [{ "id": "…", "title": "Brücke über den Bach", "status": "offen", "giver": "[[Zylia]]" }],
  "characters": [{ "id": "…", "title": "Lyssara", "player": "Mara", "class": null, "status": null }],
  "recent_entities": [{ "id": "…", "type": "npc", "title": "Zylia", "updated": "…" }],
  "counts": { "npc": 12, "location": 7, "item": 4, "faction": 2 },
  "scripts": [{ "id": "…", "title": "Abend 5 – Vallaki", "planned_for": "2026-10-25", "updated": "…" }],
  "open_proposals": 3
}
```

### Darstellung und Anhänge

| Methode | Pfad | Scope | Zweck |
|---|---|---|---|
| GET | `/vaults/{vault}/notes/{id}/html` | read | Bereinigtes HTML; `?link_base=/wiki/{vault}/{id}` (Platzhalter `{vault}`, `{id}`, `{title}`), `?visibility=players` |
| GET | `/vaults/{vault}/attachments/{name}` | read | Anhang (Bilder, PDFs, Audio) |
| POST | `/vaults/{vault}/attachments` | write | Upload (multipart, Feld `file`, max. 50 MB) → `{name, path, url, embed: "![[name]]"}` |

Links im HTML: `<a class="internal-link" href="/wiki/dnd/01JA…" data-note-id="01JA…" data-type="npc">Zylia</a>`;
nicht aufgelöste Links tragen `class="internal-link unresolved" data-unresolved="Titel"`.

### Ereignisse und Webhooks

| Methode | Pfad | Scope | Zweck |
|---|---|---|---|
| GET | `/events?vault=dnd` | read | Server-Sent Events (mehrere Vaults kommagetrennt) |
| GET | `/webhooks` | admin | Webhooks mit den letzten 20 Zustellungen |
| POST | `/webhooks` | admin | `{url, events?: [...] \| ["*"], vaults?: [...] \| ["*"], secret?}` → Secret wird einmal angezeigt |
| DELETE | `/webhooks/{id}` | admin | Löschen |

Ereignisse: `note.created`, `note.updated`, `note.renamed`, `note.deleted`, `inbox.queued`, `inbox.processed`,
`inbox.failed`, `inbox.cancelled`, `proposal.created`, `proposal.resolved`, `run.reverted`.

```json
{ "event": "inbox.processed", "vault": "dnd", "at": "2026-10-12T01:42:00+02:00",
  "data": { "inbox_id": "…", "note_id": "…", "run_id": "…", "created": 3, "updated": 5, "proposals": 2 } }
```

- **SSE:** `event: <name>` + `data: <JSON wie oben>`; alle 25 s ein Kommentar als Keep-alive. Änderungen von außen
  (SMB/Obsidian) tragen `data.external: true`.
- **Webhooks:** `POST` mit JSON-Body und den Headern `X-Basalt-Event`, `X-Basalt-Delivery` und
  `X-Basalt-Signature: sha256=<HMAC-SHA256(secret, body) hex>`. Bei Fehler (kein 2xx, Zeitlimit 10 s) bis zu
  6 Versuche mit wachsendem Abstand.

Signatur prüfen (Node):

```js
const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex')
const ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(req.headers['x-basalt-signature']))
```

### Einbett-Ansichten (iframe)

| URL | Inhalt |
|---|---|
| `/embed/{vault}/note/{id}?mode=view\|edit` | Eine Notiz lesen oder bearbeiten |
| `/embed/{vault}/campaign/{kampagne}` | Kampagnen-Startseite |
| `/embed/{vault}/search?q=…&type=…` | Suche |
| `/embed/{vault}/proposals?campaign=…` | Vorschläge prüfen |
| `/embed/{vault}/graph?campaign=…` | Graph |

Parameter: `theme=light|dark|auto`, `visibility=dm|players`, `links=internal|parent`, `token=<embed-token>`.
Erlaubte einbettende Seiten: `EMBED_ORIGINS`.

`postMessage` (nur mit erlaubten Ursprüngen):

| Richtung | Nachricht |
|---|---|
| Einbettung → Gast | `{type: "basalt:ready"}`, `{type: "basalt:resize", height}`, `{type: "basalt:navigate", noteId, title, noteType}` (bei `links=parent`), `{type: "basalt:saved", noteId, version}` |
| Gast → Einbettung | `{type: "basalt:open", noteId}`, `{type: "basalt:setTheme", theme}`, `{type: "basalt:search", q}` |

Anmeldung in Einbettungen: entweder gleiche Domain hinter dem Reverse-Proxy (Session-Cookie) oder ein
kurzlebiges Token, das der Gast-Server über `POST /tokens/embed` holt und als `?token=` anhängt.

### Beispiele mit curl

```sh
TOKEN=bn_…   # aus Einstellungen → API-Tokens
API=http://nas:4400/api/v1

# Notiz anlegen
curl -s -X POST "$API/vaults/dnd/notes" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"npc","title":"Zylia","frontmatter":{"campaign":"Fluch des Strahd","role":"Karawanenführerin"}}'

# Volltextsuche
curl -s "$API/vaults/dnd/search?q=karawane&type=npc" -H "Authorization: Bearer $TOKEN"

# Bereich in eine Notiz schreiben (ersetzt bei gleichem key)
curl -s -X PUT "$API/vaults/dnd/notes/<id>/blocks/panel%3Aencounter%3A42" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"heading":"Begegnungen","content":"- Kampf gegen Schleimmonster gewonnen"}'

# Whisper-Glossar
curl -s "$API/vaults/dnd/names?campaign=Fluch%20des%20Strahd&types=npc,location,character" -H "Authorization: Bearer $TOKEN"

# Live-Ereignisse
curl -N "$API/events?vault=dnd" -H "Authorization: Bearer $TOKEN"
```

---

## Entwicklung

Voraussetzungen: Node.js ≥ 22.13 (empfohlen 24), git.

```sh
npm install
npm run dev            # API auf :8080 (DATA_DIR=./data)
npm run dev:web        # Oberfläche auf :5173 mit Proxy auf die API
npm test               # Server-Tests (inkl. Golden-Tests für den Kurator)
npm run build          # Server, Oberfläche und SDK bauen
```

Docker-Image bauen:

```sh
docker build -t poldion/basaltnotes:latest .
```

Aufbau: `server/` (Fastify, TypeScript, SQLite über `node:sqlite`), `web/` (React, CodeMirror 6, Vite),
`packages/client/` (SDK). Die Anforderungen stehen in [`anforderungen.md`](anforderungen.md) (historisch).
