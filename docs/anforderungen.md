# Anforderungen: Notiz-App mit KI-Kurator

> **Historisches Dokument.** Das ist die ursprüngliche Anforderungsbeschreibung aus der Planungsphase (Arbeitstitel
> „Grimoire“, eine konkrete Heimnetz-Umgebung als Beispiel). Der heutige Stand steht im [Handbuch](handbuch.md);
> Abweichungen – etwa beliebige Modelle statt eines Proxys mit genau einem Modell – sind dort beschrieben.

Selbst gehostete Web-App nach dem Vorbild von Obsidian. Sie verwaltet mehrere Vaults mit Markdown-Notizen,
`[[Wiki-Links]]`, Backlinks, Eigenschaften und Suche. Ein **KI-Kurator** sortiert neu eingehende Inhalte selbstständig
in den Bestand ein: Er legt neue Charaktere, NPCs oder Orte an oder ergänzt bestehende.
Die App ist der **zentrale Wissensspeicher** für:

- **WhisperNotes** (Transkription + Session-Recaps, Mac mini) – liefert Inhalte in den Eingang
- **DM-Management-Panel** (eigene App) – zeigt Kampagnen-Übersicht und Welt-Wiki, legt Notizen an
- **dich im Browser** – Notizen lesen, schreiben und verwalten

Dieses Dokument ist die Grundlage für ein eigenes Projekt. Es beschreibt, **was** die App können muss,
und macht Vorschläge, **wie**. Offene Entscheidungen sind in Abschnitt 14 gesammelt.

---

## 1. Systemlandschaft

```
                         Heimnetz
 ┌──────────────────────────────────────────────────────────────────────┐
 │                                                                      │
 │  NAS (TrueNAS, Docker)                KI-Rechner (z. B. Mac mini)     │
 │  ┌──────────────────────────────┐     ┌──────────────────────────┐   │
 │  │ Grimoire                      │     │ WhisperNotes  :8000       │   │
 │  │  ├ Vault „DnD“                │◄────┤  POST /inbox (Session)    │   │
 │  │  ├ Vault „Notizen“            │     │                          │   │
 │  │  ├ REST-API  /api/v1          │     │ Ollama-Proxy  :11435      │   │
 │  │  ├ Einbett-Ansichten /embed   │────►│  (LLM für den Kurator)    │   │
 │  │  └ Web-Oberfläche             │     └──────────────────────────┘   │
 │  └──────▲───────────────▲───────┘                                    │
 │         │ API / Embed   │ Browser                                    │
 │  ┌──────┴────────┐   ┌──┴──────┐                                     │
 │  │ DM-Panel      │   │ du      │                                     │
 │  └───────────────┘   └─────────┘                                     │
 └──────────────────────────────────────────────────────────────────────┘
```

- **Ollama:** `http://<ki-rechner>:11435` ist ein Proxy, der genau ein Modell geladen hält (Alias `LocalLLM`).
  - `/api/ps` liefert dort 404. `/api/tags` zeigt nur das aktive Modell.
  - `/admin/state` liefert `forced_options.num_ctx` (zurzeit 8192) – das ist die tatsächliche Kontextgröße.
  - Der Kurator muss sich, wie WhisperNotes, an das **aktuell geladene Modell** und die **ermittelte Kontextgröße** anpassen
    (siehe 7.8).
- **Reverse-Proxy (empfohlen):** alle Apps unter einer Domain, z. B. `notes.home`, `panel.home`, `whisper.home`.
  Dadurch reicht ein gemeinsames Login, und die Einbettung (iframe) macht weniger Probleme.

---

## 2. Begriffe

| Begriff | Bedeutung |
|---|---|
| **Vault** | Abgeschlossene Notizsammlung = ein Ordner auf der Platte. Beispiele: „DnD“, „Notizen“. |
| **Notiz** | Markdown-Datei mit YAML-Frontmatter. Sie hat eine **stabile ID**, die sich beim Umbenennen nicht ändert. |
| **Typ** | Art der Notiz: `session`, `character`, `npc`, `location`, `faction`, `item`, `quest`, `lore`, `fact`, `note`, `meeting` … |
| **Entität** | Eine Notiz, die ein „Ding“ der Welt beschreibt (NPC, Ort, Gegenstand …). |
| **Eingang (Inbox)** | Ablage für neue Inhalte, die der Kurator noch verarbeiten soll. |
| **Kurator** | KI-Prozess, der Eingangsinhalte analysiert und Änderungen am Vault plant und anwendet. |
| **Vorschlag (Proposal)** | Eine geplante Änderung, die eine Freigabe braucht (mit Diff-Ansicht). |
| **Verwalteter Bereich (Managed Block)** | Markierter Abschnitt einer Notiz, den eine Maschine schreibt und ersetzt. Eigener Text außerhalb bleibt unberührt. |
| **Quelle (Source)** | Herkunft eines Beitrags, z. B. `whispernotes:job:ab12cd34`. Gleiche Quelle → **ersetzen statt anhängen**. |
| **Alias** | Alternative Schreibweise einer Entität („Cydia“, „Sylvia“ für „Zylia“). |

---

## 3. Ziele und Nicht-Ziele

**Ziele**
1. Obsidian-ähnliches Arbeiten im Browser: Editor, Links, Backlinks, Suche, Eigenschaften, mehrere Vaults.
2. Dateien sind die Wahrheit. Jeder Vault ist ein normaler Ordner mit `.md`-Dateien und lässt sich auch in Obsidian öffnen.
3. Vollständige, stabile REST-API, sodass andere Apps alles lesen und schreiben können.
4. KI-Kurator, der neue Inhalte einsortiert, Schreibvarianten erkennt und nichts still überschreibt.
5. Einbettbar in andere Apps: iframe-Ansichten, gerendertes HTML und JSON.
6. Ein einziger Docker-Container auf dem NAS, Daten in einem Volume.

**Nicht-Ziele (vorerst)**
- Echtzeit-Mehrbenutzer-Bearbeitung, wie bei Google Docs.
- Ersatz für das DM-Panel. Spielmechanik (Initiative, HP, Encounter) bleibt im Panel.
- Öffentliches Internet-Hosting. Die App ist fürs Heimnetz bzw. VPN gedacht.
- Kompatibilität mit dem Obsidian-Plugin-System.

---

## 4. Architektur und Technik (Vorschläge)

| Bereich | Vorschlag | Begründung |
|---|---|---|
| Backend | **TypeScript (Node 22, Fastify)** oder **Python (FastAPI)** | Fastify: gleiche Sprache wie das Frontend. FastAPI: gleiche Sprache wie WhisperNotes, die Ollama-Anbindung lässt sich von dort übernehmen. |
| Speicher | Markdown-Dateien je Vault + **SQLite** als Index (FTS5 für Volltext, Tabellen für Links/Eigenschaften/Aliasse) | Index ist jederzeit aus den Dateien neu aufbaubar. |
| Versionierung | **git je Vault**: Commit pro Speichern (gebündelt) und pro Kurator-Lauf | Verlauf, Diff, „Rückgängig“, Backup. |
| Frontend | React oder Svelte + **CodeMirror 6** (Live-Vorschau, Autovervollständigung) | Bewährte Grundlage für Markdown-Editoren. |
| Live-Updates | **Server-Sent Events** (`/api/v1/events`) | Einfach, funktioniert durch Proxys. |
| Hintergrundjobs | Warteschlange im Prozess (SQLite-Tabelle `jobs`) | Kurator-Läufe, Neuindizierung, Webhooks. |
| Dateiänderungen von außen | Dateisystem-Watcher (chokidar / watchfiles) | Bearbeitung über SMB oder Obsidian → Index wird aktualisiert. |
| Container | Ein Image, Volume `/data`, läuft nicht als root, Healthcheck `/api/v1/health` | Passt als App auf TrueNAS. |

**Ablage im Volume**
```
/data
├─ config.yaml                 # globale Einstellungen (LLM-URL, Tokens gehasht, …)
├─ index.sqlite                # Index aller Vaults (neu aufbaubar)
└─ vaults/
   ├─ dnd/
   │  ├─ .grimoire/vault.yaml  # Vault-Einstellungen, Typen, Kurator-Regeln
   │  ├─ .git/
   │  ├─ _inbox/               # Eingang (verarbeitete Einträge werden archiviert)
   │  ├─ _attachments/
   │  └─ Fluch des Strahd/
   │     ├─ Sessions/2026-10-11 Session 1.md
   │     ├─ Charaktere/Lyssara.md
   │     ├─ NPCs/Zylia.md
   │     └─ Orte/Barovia.md
   └─ notizen/
      └─ …
```

---

## 5. Datenmodell

### 5.1 Notiz-Datei

```markdown
---
id: 01JA8Z6K3P8Q2V9W4X5Y6Z7A8B        # ULID, stabil, wird nie geändert
type: npc
title: Zylia
aliases: [Cydia, Sylvia, Zyliya]
campaign: Fluch des Strahd
tags: [karawane]
status: lebendig                       # typabhängige Eigenschaften (siehe 5.3)
visibility: players                    # dm | players  (für spätere Spieler-Ansicht)
created: 2026-10-12T01:40:00+02:00
updated: 2026-10-12T01:40:00+02:00
---

# Zylia

Eigener Text des DM … (wird nie von Maschinen verändert)

## Aus den Sessions
<!-- grimoire:block key="whispernotes:job:ab12cd34" source="[[2026-10-11 Session 1]]" updated="2026-10-12T01:40" -->
- Führt die Karawane; bittet die Gruppe, den Streit zwischen Barde und Alchemist zu schlichten.
- Belohnt die Schlichtung mit einer Extra-Ration.
<!-- /grimoire:block -->
```

**Regeln**
- `id` wird beim Anlegen vergeben. Fehlt sie (z. B. Datei von außen angelegt), wird sie ergänzt.
- Links: `[[Titel]]`, `[[Titel|Anzeigetext]]`, `[[Titel#Überschrift]]`, Einbettung `![[Titel]]`. Aufgelöst wird über Titel,
  Dateiname und **Aliasse** (Groß-/Kleinschreibung egal). Intern wird zusätzlich die Ziel-ID im Index gespeichert.
- **Verwaltete Bereiche** werden über `key` adressiert. Ein Schreibzugriff mit demselben `key` ersetzt den Inhalt,
  ein neuer `key` hängt einen neuen Bereich an. Der Text außerhalb bleibt **byte-genau** erhalten.
- Beim Umbenennen bleibt die `id`, Dateiname und Titel ändern sich, und **alle Links im Vault werden angepasst**.

### 5.2 Vault-Konfiguration (`.grimoire/vault.yaml`)

```yaml
name: DnD
types:                      # welche Typen es gibt, wo sie liegen, welche Eigenschaften sie haben
  session:   { folder: "{campaign}/Sessions",    template: session }
  character: { folder: "{campaign}/Charaktere",  template: character }
  npc:       { folder: "{campaign}/NPCs",        template: npc }
  location:  { folder: "{campaign}/Orte",        template: location }
  faction:   { folder: "{campaign}/Fraktionen",  template: faction }
  item:      { folder: "{campaign}/Gegenstände", template: item }
  quest:     { folder: "{campaign}/Quests",      template: quest }
  fact:      { folder: "{campaign}",             single_note: "Gesetzte Fakten" }
curator:
  enabled: true
  auto_apply: [create_entity, append_block, add_alias, add_mention]   # ohne Freigabe
  review:     [update_property, merge_entities, contradiction, delete] # immer als Vorschlag
  min_confidence_auto: 0.8
```

### 5.3 Typen für DnD (Eigenschaften)

| Typ | Eigenschaften (Frontmatter) | Typische Abschnitte |
|---|---|---|
| `campaign` | `system` (5e), `status`, `players: [{player, character}]`, `dm` | Übersicht, Hausregeln |
| `session` | `campaign`, `number`, `date`, `players`, `source`, `transcript_url` | Was bisher geschah, Ereignisse, Spieler-Recaps, Lore |
| `character` | `campaign`, `player`, `class`, `race`, `status` | Hintergrund, Aus den Sessions |
| `npc` | `campaign`, `role`, `faction`, `attitude` (freundlich/neutral/feindlich), `status`, `location` | Beschreibung, Motive (DM), Aus den Sessions |
| `location` | `campaign`, `region`, `parent` (Link) | Beschreibung, Bewohner, Aus den Sessions |
| `faction` | `campaign`, `leader`, `attitude` | Ziele, Mitglieder |
| `item` | `campaign`, `owner`, `rarity`, `value` | Wirkung, Herkunft |
| `quest` | `campaign`, `status` (offen/erledigt/gescheitert), `giver` | Ziel, Hinweise, Fortschritt |
| `fact` | – (eine Sammelnotiz je Kampagne) | gesetzte Fakten mit Quelle |

Für den Vault „Notizen“: `note`, `meeting` (Aufnahmen aus WhisperNotes mit Aufgaben/Terminen), `person`, `project`.

---

## 6. Funktionale Anforderungen: Web-Oberfläche

**Muss (MVP)**
- F1 Vaults anlegen, umbenennen, löschen, wechseln.
- F2 Dateibaum mit Ordnern; Notiz anlegen/umbenennen/verschieben/löschen (Papierkorb).
- F3 Editor (CodeMirror 6): Live-Vorschau, Autovervollständigung für `[[Links]]` (inkl. Aliasse), Einfügen von Bildern
  (→ `_attachments`), Tastenkürzel, Autosave.
- F4 Frontmatter-Editor als Formular (Typ-abhängig), Rohansicht umschaltbar.
- F5 Backlinks-Bereich („Erwähnt in“) und ausgehende Links; nicht aufgelöste Links hervorgehoben, Klick legt die Notiz an.
- F6 Volltextsuche mit Filtern (Typ, Tag, Kampagne, Eigenschaften), Schnellöffner (Strg+O).
- F7 Umbenennen mit automatischer Anpassung aller Links.
- F8 Vorlagen je Typ.
- F9 Verlauf je Notiz (aus git) mit Diff und Wiederherstellen.
- F10 **Eingang**: Liste der Einträge mit Status (wartet, läuft, verarbeitet, Fehler) und Ergebnis des Kurators.
- F11 **Vorschläge**: Liste offener Vorschläge mit Diff, *Annehmen / Bearbeiten / Ablehnen*, auch gesammelt.
- F12 **Kurator-Protokoll**: Was wurde wann aus welcher Quelle geändert, mit „Lauf rückgängig machen“.
- F13 Hell/Dunkel, responsive bis Handybreite, deutsche Oberfläche.

**Soll**
- F14 Kampagnen-Startseite: Timeline der Sessions, offene Quests, zuletzt geänderte Entitäten (Grundlage für das Panel-Wiki).
- F15 Tabellen-/Listenabfragen in Notizen (Dataview-ähnlich, siehe API `query`), z. B. „alle NPCs mit Fraktion X“.
- F16 Graph-Ansicht (je Kampagne, nach Typ filterbar).
- F17 PWA (installierbar am Handy), Offline-Lesen.
- F18 Spieler-Ansicht: nur Notizen/Bereiche mit `visibility: players`, Nur-Lese-Link pro Kampagne.

---

## 7. KI-Kurator

### 7.1 Auslöser
- Neuer Eingangseintrag über API oder UI (z. B. von WhisperNotes oder aus dem Panel).
- Manuell: „Notiz durch Kurator laufen lassen“ für eine beliebige Notiz.
- Erneut verarbeiten: gleiche Quelle → alter Beitrag wird **ersetzt**, nicht verdoppelt.

### 7.2 Ablauf

```
Eingang → 1 Erkennen → 2 Abgleichen → 3 Planen → 4 Anwenden/Vorschlagen → Protokoll (+ git-Commit)
```

**1. Erkennen (Extraktion).**
- Das LLM bekommt den Eingangstext und eine **Liste der bekannten Namen und Aliasse** der Kampagne (kompakt).
- Es antwortet mit **festem JSON-Schema**. Ollama kann das erzwingen: `format` mit dem JSON-Schema übergeben.
- Lange Eingaben werden abschnittsweise extrahiert, die Ergebnisse dann zusammengeführt.

```json
{
  "entities": [
    {
      "name": "Zylia",
      "type": "npc",
      "mentioned_as": ["Cydia", "Zylia"],
      "summary": "Karawanenführerin",
      "facts": ["Bittet die Gruppe, den Streit zu schlichten", "Belohnt mit Extra-Ration"],
      "properties": {"role": "Karawanenführerin", "attitude": "freundlich"},
      "visibility": "players",
      "confidence": 0.9
    }
  ],
  "events": [{"text": "Wagen bleibt im Sumpf stecken; Schleimmonster greift an", "entities": ["Schleimmonster"]}],
  "quests": [{"title": "Brücke über den Bach", "status": "offen", "giver": null}],
  "facts": [{"text": "Die Karawane fährt von Valerius nach …", "visibility": "dm"}]
}
```

**2. Abgleichen (Entity Resolution).** Für jede Entität:
1. Exakter Treffer auf Titel/Alias (gleiche Kampagne, gleicher Typ) → eindeutig.
2. Sonst Kandidaten über Volltextsuche + Ähnlichkeit der Schreibweise (z. B. Jaro-Winkler/Levenshtein, Phonetik
   „Kölner Phonetik“ für deutsche Namen) → Top 3.
3. Bei mehreren oder schwachen Kandidaten: **LLM entscheidet** mit Kurzfassungen der Kandidaten-Notizen
   („gleiche Person / neue Person“) → `confidence`.
4. Ergebnis: `match: <note-id>` oder `new`.

**3. Planen.** Ein Änderungsplan aus atomaren Operationen:

| Operation | Beispiel | Standard |
|---|---|---|
| `create_entity` | neue NPC-Notiz aus Vorlage | automatisch |
| `append_block` | Session-Beitrag in „Aus den Sessions“ (Key = Quelle) | automatisch |
| `add_mention` | Backlink „Erwähnt in [[Session 3]]“ | automatisch |
| `add_alias` | „Cydia“ als Alias bei Zylia | automatisch |
| `update_property` | `status: tot`, `attitude: feindlich` | **Vorschlag** |
| `contradiction` | neue Info widerspricht bestehender (z. B. andere Herkunft) | **Vorschlag** |
| `merge_entities` | zwei Notizen sind dieselbe Person | **Vorschlag** |
| `link_quest` / `update_quest` | Quest erledigt | **Vorschlag** |

Welche Operationen automatisch laufen, steht in `vault.yaml` (`auto_apply`, `review`, `min_confidence_auto`).
Alles unter der Mindest-Sicherheit wird **immer** zum Vorschlag.

**4. Anwenden.**
- Automatische Operationen werden in **einem Lauf** angewendet und in **einem git-Commit** gesichert
  (Nachricht: `Kurator: whispernotes:job:ab12cd34 (Session 1)`).
- Alle anderen Operationen werden zu Vorschlägen.

### 7.3 Herkunft und Wiederholbarkeit
- Jeder Beitrag trägt seine Quelle (`key`) und einen Link zur Quellnotiz.
- Erneute Verarbeitung derselben Quelle ersetzt alle Blöcke mit diesem `key`. Blöcke, die nicht mehr vorkommen,
  werden entfernt.
- Das Protokoll speichert je Lauf: Eingabe, erkannte Entitäten, Plan, angewendete Operationen, git-Commit.

### 7.4 Aliasse und Schreibvarianten
- Erkannte Varianten werden als `aliases` nachgetragen (automatisch, abschaltbar).
- Der Kurator stellt die Namensliste der Kampagne bereit (`GET …/names`). WhisperNotes kann sie als
  **Whisper-Glossar** nutzen, dann verbessert sich die Spracherkennung mit jeder Session (siehe 10.4).

### 7.5 Sichtbarkeit
- Inhalte aus der DM-Lore bekommen `visibility: dm`, Spielgeschehen `players`. Verwaltete Bereiche können eine eigene
  Sichtbarkeit tragen (`<!-- grimoire:block … visibility="dm" -->`).

### 7.6 Sicherheit gegen Fehlgriffe
- Der Kurator schreibt **nie** außerhalb verwalteter Bereiche und ändert keinen Text, den ein Mensch geschrieben hat.
- Löschen, Zusammenführen und Widersprüche immer nur als Vorschlag.
- „Trockenlauf“: Ein Lauf zeigt nur den Plan, ohne etwas zu ändern.
- „Lauf rückgängig“: git-Revert des Kurator-Commits, die Vorschläge des Laufs werden verworfen.

### 7.7 Spätere Ausbaustufe: „Frag deinen Vault“
- Fragen in natürlicher Sprache („Was wissen wir über die Fraktion X?“) → Suche + LLM-Antwort mit Quellenlinks.
- Session-Vorbereitung: „Offene Fäden für die nächste Session“ aus Quests und Vorschlägen.

### 7.8 LLM-Anbindung
- Konfigurierbar: `LLM_URL` (Standard `http://<ki-rechner>:11435`), optional `LLM_MODEL`. Ohne Angabe wird das **aktuell
  geladene Modell** genommen: `/api/ps`, bei 404 `/api/tags`.
- **Kontextgröße ermitteln:** Konfiguration > `/api/ps` (`context_length`) > Proxy `/admin/state`
  (`forced_options.num_ctx`) > 4096. Für jeden Schritt wird das Zeichenbudget berechnet:
  (Kontext − Systemprompt − Antwortreserve) × ~3 Zeichen/Token.
- `temperature` 0.1–0.2 für Extraktion und Abgleich. Thinking aus (verbraucht Kontext).
- Aufrufe nacheinander, über eine Warteschlange (der Proxy hält nur ein Modell). Wiederholversuche bei Fehlern,
  Zeitlimit pro Aufruf.
- Vorlage: `backend/app/ollama.py` in WhisperNotes (`context_length`, `input_budget`, `summarize_documents`).

---

## 8. REST-API

### 8.1 Grundsätze
- Basis-URL `/api/v1`, JSON (UTF-8), Zeitstempel ISO-8601 mit Zeitzone.
- **Authentifizierung**
  - Oberfläche: Login mit Session-Cookie (SameSite=Lax, CSRF-Token bei schreibenden Aufrufen).
  - Apps: `Authorization: Bearer <token>`.
  - Tokens gibt es je Vault mit **Scopes**: `read`, `write`, `inbox` (nur in den Eingang schreiben), `curate`, `admin`.
  - WhisperNotes bekommt z. B. nur `inbox` + `read` für „DnD“ und „Notizen“.
- **Gleichzeitiges Bearbeiten:** Jede Notiz hat eine `version` (Hash des Inhalts), die auch als `ETag` mitkommt.
  Schreibzugriffe brauchen `If-Match: <version>`. Passt die Version nicht, gibt es `409 Conflict` mit aktuellem Stand.
- **Idempotenz:** `Idempotency-Key`-Header bei `POST`. Ein wiederholter Aufruf mit demselben Schlüssel liefert dasselbe Ergebnis.
- **Seitenweise Abruf:** `limit` (Standard 50, max. 500) und `cursor` (aus der vorigen Antwort).
- **Fehlerformat:**
  ```json
  { "error": { "code": "version_conflict", "message": "Die Notiz wurde inzwischen geändert.", "details": {"current_version": "…"} } }
  ```
  Codes: `not_found`, `validation_error`, `version_conflict`, `forbidden`, `unauthorized`, `rate_limited`, `llm_unavailable`.
- **CORS:** Liste erlaubter Ursprünge, z. B. das Panel. Keine Wildcard.

### 8.2 Vaults

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/vaults` | Liste (id, name, Anzahl Notizen, Typen) |
| POST | `/vaults` | anlegen `{name, preset: "dnd" \| "notes" \| "empty"}` |
| GET / PATCH / DELETE | `/vaults/{vault}` | Details / Einstellungen / löschen (nur `admin`) |
| GET | `/vaults/{vault}/types` | Typen mit Eigenschafts-Schema und Ordnern (für dynamische Formulare in anderen Apps) |
| POST | `/vaults/{vault}/reindex` | Index neu aufbauen |

### 8.3 Notizen

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/vaults/{v}/notes` | Liste mit Filtern: `type`, `tag`, `campaign`, `prop.<name>=<wert>`, `q`, `updated_since`, `sort`, `fields` |
| GET | `/vaults/{v}/notes/{id}` | Notiz; `?format=json` (Standard) \| `markdown` \| `html` |
| GET | `/vaults/{v}/notes/by-path?path=…` / `by-title?title=…` | Notiz über Pfad bzw. Titel/Alias finden |
| POST | `/vaults/{v}/notes` | anlegen `{type, title, frontmatter, body, folder?, template?}` → `201` mit `id`, `version` |
| PUT | `/vaults/{v}/notes/{id}` | komplett ersetzen (braucht `If-Match`) |
| PATCH | `/vaults/{v}/notes/{id}` | Teiländerung: `frontmatter` zusammenführen, `append` (Text ans Ende oder unter Überschrift) |
| DELETE | `/vaults/{v}/notes/{id}` | in den Papierkorb |
| POST | `/vaults/{v}/notes/{id}/rename` | `{title?, folder?}` – passt alle Links an |
| GET | `/vaults/{v}/notes/{id}/backlinks` | eingehende Links mit Kontextausschnitt |
| GET | `/vaults/{v}/notes/{id}/links` | ausgehende Links (aufgelöst/unaufgelöst) |
| GET | `/vaults/{v}/notes/{id}/history` | Versionen (git) |
| GET | `/vaults/{v}/notes/{id}/history/{rev}` | Inhalt einer Version, `?diff=1` als Diff zur aktuellen |
| POST | `/vaults/{v}/notes/{id}/restore` | `{rev}` wiederherstellen |

**Antwort `GET /notes/{id}` (JSON)**
```json
{
  "id": "01JA8Z6K3P8Q2V9W4X5Y6Z7A8B",
  "vault": "dnd",
  "path": "Fluch des Strahd/NPCs/Zylia.md",
  "type": "npc",
  "title": "Zylia",
  "aliases": ["Cydia", "Sylvia"],
  "frontmatter": {"campaign": "Fluch des Strahd", "role": "Karawanenführerin", "status": "lebendig", "visibility": "players"},
  "body": "# Zylia\n\nEigener Text …",
  "blocks": [{"key": "whispernotes:job:ab12cd34", "source_note": "01JA…", "visibility": "players", "updated": "…"}],
  "links": [{"target_id": "01JA…", "text": "Barovia", "resolved": true}],
  "backlink_count": 4,
  "version": "sha1:9f2c…",
  "created": "…",
  "updated": "…"
}
```

### 8.4 Verwaltete Bereiche (für Maschinen)

| Methode | Pfad | Zweck |
|---|---|---|
| PUT | `/vaults/{v}/notes/{id}/blocks/{key}` | Bereich setzen/ersetzen `{content, heading?: "Aus den Sessions", source_note?, visibility?}` |
| DELETE | `/vaults/{v}/notes/{id}/blocks/{key}` | Bereich entfernen |
| DELETE | `/vaults/{v}/blocks?key=…` | alle Bereiche einer Quelle im Vault entfernen (z. B. Session gelöscht) |

Blöcke brauchen **kein** `If-Match`: Sie berühren den menschlichen Text nicht, und der Server führt sie atomar zusammen.

### 8.5 Suche, Abfragen, Namen

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/vaults/{v}/search?q=…&type=…&campaign=…` | Volltext mit Treffer-Ausschnitten (`highlights`) |
| POST | `/vaults/{v}/query` | strukturierte Abfrage (Dataview-ähnlich), siehe unten |
| GET | `/vaults/{v}/resolve?name=Cydia&type=npc&campaign=…` | Kandidaten mit `score` (für Apps und den Kurator) |
| GET | `/vaults/{v}/names?campaign=…&types=npc,location` | alle Titel + Aliasse, kompakt (z. B. als Whisper-Glossar) |
| GET | `/vaults/{v}/tags` | Tags mit Anzahl |
| GET | `/vaults/{v}/graph?campaign=…&type=…` | Knoten + Kanten für Graph-Ansichten |

**Abfrage**
```json
POST /api/v1/vaults/dnd/query
{
  "where": [{"field": "type", "op": "=", "value": "npc"},
            {"field": "campaign", "op": "=", "value": "Fluch des Strahd"},
            {"field": "attitude", "op": "in", "value": ["feindlich", "neutral"]}],
  "sort": [{"field": "updated", "dir": "desc"}],
  "select": ["title", "role", "faction", "status", "updated"],
  "limit": 100
}
```

### 8.6 Eingang (Inbox)

| Methode | Pfad | Zweck |
|---|---|---|
| POST | `/vaults/{v}/inbox` | Inhalt einliefern → `202 {inbox_id, status: "queued"}` |
| GET | `/vaults/{v}/inbox?status=…` | Liste |
| GET | `/vaults/{v}/inbox/{id}` | Status, erzeugte Notiz, Lauf, Vorschläge |
| POST | `/vaults/{v}/inbox/{id}/reprocess` | erneut verarbeiten (ersetzt alte Beiträge derselben Quelle) |
| DELETE | `/vaults/{v}/inbox/{id}` | verwerfen |

**Einliefern**
```json
POST /api/v1/vaults/dnd/inbox
Idempotency-Key: whispernotes:job:ab12cd34:v3
{
  "source": {"app": "whispernotes", "key": "whispernotes:job:ab12cd34", "url": "http://whispernotes.local:8000/dashboard/#dnd"},
  "note": {
    "type": "session",
    "title": "2026-10-11 Session 1",
    "frontmatter": {
      "campaign": "Fluch des Strahd",
      "number": 1,
      "date": "2026-10-11T22:00:00+02:00",
      "players": [{"player": "Robin", "character": null, "role": "dm"},
                  {"player": "Mara", "character": "Lyssara"}],
      "duration_seconds": 1728,
      "transcript_url": "http://whispernotes.local:8000/api/jobs/ab12cd34/transcript?format=md"
    },
    "body": "## Was bisher geschah\n…\n## Ereignisse\n…"
  },
  "attachments": [
    {"name": "Spieler-Recaps", "kind": "players_recap", "markdown": "## Lyssara (Mara)\n…"},
    {"name": "Welt & Lore", "kind": "lore", "markdown": "## NPCs\n…", "visibility": "dm"}
  ],
  "curate": "auto"
}
```
- `curate`: `auto` (Regeln aus `vault.yaml`), `review` (alles als Vorschlag), `none` (nur ablegen).
- Die Session-Notiz wird **sofort** angelegt bzw. bei gleicher `source.key` aktualisiert. Der Kurator läuft danach im Hintergrund.
- `attachments` werden in die Session-Notiz eingebettet (eigene Abschnitte bzw. verwaltete Bereiche) und dienen dem Kurator
  als Hauptquelle.

### 8.7 Vorschläge und Kurator-Läufe

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/vaults/{v}/proposals?status=open&campaign=…` | offene Vorschläge |
| GET | `/vaults/{v}/proposals/{id}` | Details mit `diff` (unified) und Begründung des Kurators |
| PATCH | `/vaults/{v}/proposals/{id}` | Inhalt vor dem Annehmen anpassen |
| POST | `/vaults/{v}/proposals/{id}/accept` \| `/reject` | annehmen / ablehnen |
| POST | `/vaults/{v}/proposals/bulk` | `{ids, action}` |
| GET | `/vaults/{v}/runs` / `/runs/{id}` | Kurator-Läufe mit Plan und Ergebnis |
| POST | `/vaults/{v}/runs/{id}/revert` | Lauf rückgängig machen |
| POST | `/vaults/{v}/notes/{id}/curate` | eine bestehende Notiz durch den Kurator schicken (`?dry_run=1`) |

### 8.8 Kampagnen-Sicht (bequemer Endpunkt für das DM-Panel)

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/vaults/{v}/campaigns` | Kampagnen (Notizen vom Typ `campaign`) |
| GET | `/vaults/{v}/campaigns/{campaign}/overview` | alles für eine Startseite in einem Aufruf |
| GET | `/vaults/{v}/campaigns/{campaign}/timeline` | Sessions chronologisch mit Kurz-Recap |

```json
GET /api/v1/vaults/dnd/campaigns/fluch-des-strahd/overview?visibility=dm
{
  "campaign": {"id": "…", "title": "Fluch des Strahd", "players": [...]},
  "last_session": {"id": "…", "title": "2026-10-11 Session 1", "recap_excerpt": "Die Gruppe …"},
  "sessions": [{"id": "…", "number": 1, "date": "…", "title": "…"}],
  "open_quests": [{"id": "…", "title": "Brücke über den Bach", "status": "offen"}],
  "characters": [{"id": "…", "title": "Lyssara", "player": "Mara"}],
  "recent_entities": [{"id": "…", "type": "npc", "title": "Zylia", "updated": "…"}],
  "counts": {"npc": 12, "location": 7, "item": 4, "faction": 2},
  "open_proposals": 3
}
```
`visibility=players` filtert DM-Inhalte heraus. Das ist die Grundlage für eine spätere Spieler-Ansicht.

### 8.9 Darstellung für andere Apps

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/vaults/{v}/notes/{id}/html?link_base=…&visibility=…` | gerendertes, **bereinigtes** HTML (serverseitig sanitized) |
| GET | `/vaults/{v}/attachments/{name}` | Anhänge (Bilder) |
| POST | `/vaults/{v}/attachments` | Upload (multipart) |

`link_base` ist eine Vorlage für Links im HTML, z. B. `/wiki/{vault}/{id}` → `[[Zylia]]` wird zu
`<a href="/wiki/dnd/01JA…" data-note-id="01JA…" data-type="npc">Zylia</a>`. So zeigt das Panel Notizen in seinem eigenen
Layout und behält die eigene Navigation.

### 8.10 Ereignisse und Webhooks

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/events?vault=dnd` | Server-Sent Events für Live-Aktualisierung |
| GET / POST / DELETE | `/webhooks` | Webhooks verwalten `{url, events, vaults, secret}` |

Ereignisse: `note.created`, `note.updated`, `note.renamed`, `note.deleted`, `inbox.queued`, `inbox.processed`,
`inbox.failed`, `proposal.created`, `proposal.resolved`, `run.reverted`.

```json
{ "event": "inbox.processed", "vault": "dnd", "at": "…",
  "data": {"inbox_id": "…", "note_id": "…", "run_id": "…", "created": 3, "updated": 5, "proposals": 2} }
```
Webhooks werden mit `X-Grimoire-Signature: sha256=<HMAC(secret, body)>` signiert, bei Fehlern wird es mit Backoff erneut
versucht, die Zustellungen werden protokolliert.

### 8.11 System

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/health` | Status (Index, LLM erreichbar, aktives Modell, Kontextgröße, Warteschlange) |
| GET / POST / DELETE | `/tokens` | API-Tokens mit Scopes (nur `admin`, das Token wird nur einmal angezeigt) |
| GET | `/openapi.json` | OpenAPI-Beschreibung (aus dem Code erzeugt) – Grundlage für Clients |

---

## 9. Einbindung in andere Apps

Drei Wege, die sich kombinieren lassen:

| Weg | Wie | Gut für | Aufwand im Gast |
|---|---|---|---|
| **A: Einbett-Ansicht (iframe)** | `/embed/…` ohne Seitenleisten, Kommunikation per `postMessage` | Bearbeiten, Editor, Vorschläge prüfen | gering |
| **B: HTML-API** | `…/html?link_base=…` in eigenes Layout einsetzen | Lese-Wiki im eigenen Look | mittel |
| **C: JSON-API** | Daten holen, eigene Komponenten | Übersichten, Tabellen, Karten, Dashboards | höher, dafür volle Kontrolle |

### 9.1 Einbett-Ansichten

| URL | Inhalt |
|---|---|
| `/embed/{vault}/note/{id}?mode=view\|edit` | eine Notiz (lesen oder bearbeiten) |
| `/embed/{vault}/campaign/{campaign}` | Kampagnen-Startseite (siehe 8.8) |
| `/embed/{vault}/search?q=…&type=…` | Suche mit Ergebnisliste |
| `/embed/{vault}/proposals?campaign=…` | Vorschläge prüfen |
| `/embed/{vault}/graph?campaign=…` | Graph |

Parameter: `theme=light|dark|auto`, `visibility=dm|players`, `links=internal|parent`.

**`postMessage`-Protokoll** (Ursprung wird gegen die erlaubte Liste geprüft):
- Einbettung → Gast:
  - `{type:"grimoire:ready"}`
  - `{type:"grimoire:navigate", noteId, title, noteType}` (bei `links=parent` → Gast entscheidet, z. B. eigene Route)
  - `{type:"grimoire:resize", height}`
  - `{type:"grimoire:saved", noteId, version}`
- Gast → Einbettung:
  - `{type:"grimoire:open", noteId}`
  - `{type:"grimoire:setTheme", theme}`
  - `{type:"grimoire:search", q}`

**Anmeldung in Einbettungen:** Gleiche Domain hinter dem Reverse-Proxy plus Session-Cookie (einfachste Lösung).
Alternativ ein kurzlebiges **Embed-Token**, das der Gast-Server über die API holt (`POST /tokens/embed {vault, scope:
read, ttl: 3600}`) und als `?token=` anhängt.

### 9.2 Kleines JS-SDK (empfohlen)
`@grimoire/client` (TypeScript, aus `openapi.json` erzeugt + Komfortfunktionen):
```ts
const g = new Grimoire({ baseUrl: 'https://notes.home', token })
const overview = await g.campaigns.overview('dnd', 'fluch-des-strahd')
const html = await g.notes.html('dnd', noteId, { linkBase: '/wiki/dnd/{id}' })
g.events.on('inbox.processed', (e) => toast(`${e.data.created} neue Einträge`))
```
Optional zusätzlich ein Web-Component-Paket für Weg B/C:
`<grimoire-note vault="dnd" note-id="…">`, `<grimoire-search>`, `<grimoire-backlinks>`.

---

## 10. Integration: WhisperNotes → Grimoire

### 10.1 Ablauf
1. Session in WhisperNotes fertig (Recap, Spieler-Recaps, Lore erzeugt).
2. WhisperNotes ruft `POST /vaults/dnd/inbox` auf (siehe 8.6). Standard-Aufnahmen gehen an `POST /vaults/notizen/inbox`.
3. Grimoire legt die Session-Notiz an bzw. aktualisiert sie, der Kurator sortiert ein.
4. „Neu zusammenfassen“ oder „Neu transkribieren“ in WhisperNotes → gleiche `source.key` → Beiträge werden ersetzt.

### 10.2 Zuordnung der Felder

| WhisperNotes | Grimoire |
|---|---|
| Job-ID | `source.key = whispernotes:job:<id>` |
| Kampagne (Name) | `frontmatter.campaign` – Kampagne in Grimoire per Name zuordnen, bei Bedarf anlegen |
| Session-Titel, Aufnahmezeit | `title = "<YYYY-MM-DD> <Session-Titel>"`, `frontmatter.date` |
| Spieler (`name`, `character`, `role`) | `frontmatter.players` |
| `summary.md` (Recap) | `note.body` |
| `recap_players.md` | `attachments[kind=players_recap]` |
| `recap_lore.md` | `attachments[kind=lore, visibility=dm]` |
| Transkript | `frontmatter.transcript_url` (Link, kein Inhalt – Transkripte sind groß) |
| Standard-Aufnahme: Termine/Aufgaben | `type: meeting`, Aufgaben als `- [ ] … 📅 YYYY-MM-DD` |

### 10.3 Was WhisperNotes dafür noch braucht (anderes Projekt, zur Abstimmung)
- Einstellungen: `GRIMOIRE_URL`, `GRIMOIRE_TOKEN`, Vault pro Art (DnD/Standard), an/aus je Kampagne.
- Export nach jeder fertigen Zusammenfassung; Wiederholversuche, wenn Grimoire nicht erreichbar ist.
- Status an der Session-Karte („in Grimoire abgelegt ✓“, Link zur Notiz).
- Optional: Deep-Link in den Player (`/dashboard/#job=<id>&t=<sekunden>`) für Zeitstempel-Links aus Grimoire.

### 10.4 Rückkanal (optional, sinnvoll)
- WhisperNotes holt vor der Transkription `GET /vaults/dnd/names?campaign=…` und nutzt die Namen + Aliasse als
  **Whisper-Glossar**. So verhört sich Whisper seltener bei NPCs und Orten, und das Glossar pflegt sich selbst.
- Ebenso als Kontext für die Recaps (richtige Schreibweise der Namen).

---

## 11. Integration: DM-Management-Panel

### 11.1 Ansichten im Panel

1. **Kampagnen-Übersicht** (Startseite der Kampagne) – `GET …/campaigns/{c}/overview`
   - „Was bisher geschah“ der letzten Session (zum Vorlesen)
   - Timeline der Sessions
   - offene Quests
   - zuletzt geänderte NPCs und Orte
   - Hinweis auf offene Vorschläge des Kurators
2. **Welt-Wiki** (Weg B oder C)
   - Navigation nach Typ: Charaktere, NPCs, Orte, Fraktionen, Gegenstände, Quests – `POST …/query`
   - Detailseite: HTML über `…/html?link_base=/wiki/{vault}/{id}`, darunter Backlinks („Erwähnt in Session 1, 3“) über
     `…/backlinks`
   - Suche (`…/search`) mit Schnellöffner
   - Umschalter DM- und Spieler-Sicht (`visibility`)
3. **Session-Ansicht**: Recap, Spieler-Recaps, Lore der Session; Link zum Transkript/Player in WhisperNotes.
4. **Schnellnotiz während der Session**: Textfeld → `POST …/inbox` (`curate: review`), z. B. „Gruppe hat den Schlüssel an
   den Händler verkauft“. Der Kurator ordnet die Notiz nach der Session zu.
5. **Bearbeiten**: „In Grimoire bearbeiten“ öffnet die iframe-Einbettung (`mode=edit`) im Panel.
6. **Vorschläge prüfen**: iframe `/embed/{vault}/proposals?campaign=…` oder eigene Liste über die API.

### 11.2 Verknüpfung mit Panel-Daten
- Speichert das Panel eigene Objekte (Encounter, Monster, Initiative), dann speichert es dazu die **Grimoire-Notiz-ID**
  (nicht den Titel – IDs überleben Umbenennungen).
- Spielmechanik bleibt im Panel, Erzählerisches in Grimoire. Jede Information hat **genau einen** Speicherort.
- Live-Aktualisierung über SSE `/events` oder einen Webhook an das Panel-Backend.

### 11.3 Beispiel: Wiki-Seite im Panel (Weg B)
```ts
// Route /wiki/:vault/:id im Panel
const note = await g.notes.get(vault, id)                       // Titel, Typ, Eigenschaften
const html = await g.notes.html(vault, id, { linkBase: '/wiki/{vault}/{id}', visibility: 'dm' })
const backlinks = await g.notes.backlinks(vault, id)
render(<WikiPage title={note.title} props={note.frontmatter} html={html} backlinks={backlinks} />)
```

---

## 12. Nicht-funktionale Anforderungen

| Bereich | Anforderung |
|---|---|
| Leistung | bis 10 000 Notizen je Vault; Suche < 200 ms; Notiz öffnen < 100 ms; Index-Neuaufbau < 1 min |
| Robustheit | Schreiben atomar (temporäre Datei + Umbenennen); Index-Fehler blockieren das Schreiben nicht; nach Absturz kein Datenverlust |
| Dateien von außen | Änderungen über SMB oder Obsidian werden innerhalb weniger Sekunden erkannt und indiziert; Konflikt mit offener Bearbeitung → Hinweis im Editor |
| Obsidian-kompatibel | Frontmatter, `aliases`, `tags`, `[[Links]]`, `![[Einbettungen]]` im Obsidian-Format; Steuerkommentare stören Obsidian nicht |
| Sicherheit | nur Heimnetz/VPN; Passwörter gehasht (argon2), Tokens nur als Hash gespeichert; HTML serverseitig bereinigt; CSP; CORS-Liste; Rate-Limit für Login und API |
| Backup | Vault-Ordner + git = Backup; Export als ZIP über die UI; TrueNAS-Snapshots des Volumes empfohlen |
| Betrieb | ein Container, Volume `/data`, Konfiguration über Umgebungsvariablen + `config.yaml`, strukturierte Logs, Healthcheck |
| Tests | API-Vertragstests aus `openapi.json`; Tests für Link-Auflösung, Umbenennen, Blöcke und Versionskonflikte; **Golden-Tests für den Kurator** mit echten Session-Recaps aus WhisperNotes (inkl. Schreibvarianten wie Zylia/Cydia/Sylvia) |
| Sprache | Oberfläche Deutsch; Inhalte beliebig |
| Barrierefreiheit | Tastaturbedienung, ausreichende Kontraste, Fokus sichtbar |

---

## 13. Umsetzung in Phasen

| Phase | Inhalt | Abnahme |
|---|---|---|
| **1 – Kern** | Vaults, Dateien + Index, Notiz-API (8.2–8.4), Suche, Backlinks, Umbenennen mit Link-Update, git-Verlauf, Docker | Ein Vault lässt sich parallel in Obsidian öffnen, Änderungen in beide Richtungen kommen an; alle API-Tests grün |
| **2 – Oberfläche** | Editor, Dateibaum, Frontmatter-Formulare, Vorlagen, Suche, Verlauf, Hell/Dunkel | Kampagne mit 50 Notizen komfortabel im Browser pflegbar, auch am Handy |
| **3 – Eingang + Kurator (nur Vorschläge)** | Inbox-API, Extraktion, Abgleich, Pläne, Vorschlags-UI, Protokoll | Session-Recap aus WhisperNotes → sinnvolle Vorschläge; keine Doppelungen bei erneuter Verarbeitung |
| **4 – Kurator automatisch** | `auto_apply`, Lauf rückgängig, Aliasse lernen, Kampagnen-Übersicht | 3 echte Sessions eingespielt, Fehlerquote akzeptabel, alles zurücknehmbar |
| **5 – Einbindung** | Embed-Ansichten, HTML-API, SSE, Webhooks, JS-SDK, OpenAPI | DM-Panel zeigt Übersicht + Wiki; WhisperNotes liefert automatisch |
| **6 – Ausbau** | Abfragen in Notizen, Graph, Spieler-Ansicht, PWA/offline, „Frag deinen Vault“ | nach Bedarf |

---

## 14. Offene Entscheidungen

1. **Backend-Sprache:** TypeScript/Fastify (ein Stack mit dem Frontend) oder Python/FastAPI (Code aus WhisperNotes wiederverwendbar)?
2. **Frontend-Framework:** React oder Svelte?
3. **Login:** eigenes Login (ein Benutzer) oder vorhandene Anmeldung am Reverse-Proxy (z. B. Authelia/Authentik) nutzen?
4. **Mehrere Benutzer?** (z. B. Spieler mit eigenem Zugang) – beeinflusst Rechte und Sichtbarkeit.
5. **Kampagne = Ordner oder eigener Vault?** Vorschlag: ein Vault „DnD“, Kampagnen als Ordner + `campaign`-Eigenschaft.
6. **Spracherkennung der Entitäten:** reicht das lokale LLM (gemma4 e4b/12b) oder zusätzlich Embeddings für die Ähnlichkeitssuche
   (Ollama kann Embedding-Modelle wie `nomic-embed-text` laden – Achtung: Der Proxy hält nur ein Modell)?
7. **Panel-Integration:** Weg A (iframe), B (HTML) oder C (JSON) für das Wiki – Vorschlag: B für das Wiki, A fürs Bearbeiten.

---

## 15. Anhang

### 15.1 Beispiel: Extraktions-Prompt (Skizze)
```
System: Du bist der Archivar einer D&D-Kampagne. Lies den Session-Text und gib NUR JSON nach dem Schema zurück.
- Verwende für bekannte Entitäten exakt den Namen aus der Liste „Bekannte Namen“ (auch wenn der Text ihn anders schreibt)
  und trage die abweichende Schreibweise in "mentioned_as" ein.
- Erfinde nichts. Nur was im Text steht.
- "visibility": "dm" für Geheimnisse/Motive/Hintergründe, die die Spielenden nicht erfahren haben, sonst "players".
Bekannte Namen (Kampagne Fluch des Strahd): Zylia [Cydia, Sylvia] (npc), Valerius (npc), Barovia (location), …
User: <Recap + Lore der Session>
```

### 15.2 Beispiel: Abgleich-Prompt (Skizze)
```
System: Entscheide, ob die neue Erwähnung dieselbe Entität ist wie einer der Kandidaten. Antworte mit JSON
{"match": "<id>|new", "confidence": 0..1, "reason": "…"}.
Neue Erwähnung: "Cydia, Karawanenführerin, bittet die Gruppe den Streit zu schlichten"
Kandidaten:
1. 01JA… Zylia (npc) – Karawanenführerin; Aliasse: Sylvia
2. 01JB… Lydia (npc) – Kurtisane der Karawane
```

### 15.3 Änderungsplan (Schema-Skizze)
```json
{
  "run_id": "…",
  "source_key": "whispernotes:job:ab12cd34",
  "operations": [
    {"op": "create_entity", "type": "npc", "title": "Schleimmonster", "frontmatter": {...}, "confidence": 0.85, "auto": true},
    {"op": "append_block", "note_id": "01JA…", "heading": "Aus den Sessions", "content": "- …", "auto": true},
    {"op": "add_alias", "note_id": "01JA…", "alias": "Cydia", "auto": true},
    {"op": "update_property", "note_id": "01JC…", "field": "status", "from": "offen", "to": "erledigt",
     "reason": "Quest im Recap als abgeschlossen beschrieben", "confidence": 0.7, "auto": false}
  ]
}
```

### 15.4 Testmaterial
- Session-Recaps, Spieler-Recaps und Lore aus WhisperNotes (Kampagne „Tests“, Session vom 10./11.10.2026).
- Bekannte Schreibvarianten aus den Transkripten: Zylia/Cydia/Sylvia/Zyliya, Drog Bo/Drogbo/Drogo/Rocco,
  Lyssara/Lusara/Lyusara, Valerius/Valerios, Livia/Lydia/Lyvia – gute Fälle für den Abgleich.
