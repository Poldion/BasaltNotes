# Plan: Freie Vaults und Blueprints

Stand: 28.10.2026 · Status: Release 1 (freier Vault) umgesetzt in 0.20.0, Releases 2–4 offen

## Ziel

Beim Anlegen eines Vaults wählt man:

- **Frei** – keine Typen, keine Pflichtfelder, beliebige Ordner. Notizen schreiben wie in Obsidian.
- **Nach Blueprint** – ein Regelwerk bestimmt Typen, Felder, Ordner, Vorlagen und **was der Kurator wie
  einsortiert**. „D&D“ wird ein mitgelieferter Blueprint, daneben z. B. „Besprechungen“, „Projekte“ oder eigene.

Ein Blueprint ist ein **Regeldokument** (Markdown mit YAML-Kopf), das man in der Oberfläche bearbeitet, exportiert,
importiert und aus einem bestehenden Vault ableiten kann.

**Maßstab:** Bestehende D&D-Vaults verhalten sich nach der Umstellung exakt wie vorher – alle heutigen Kurator-Tests
laufen unverändert durch.

## Was heute fest im Code steckt

| Stelle | Heute | Wird zu |
|---|---|---|
| `notes/presets.ts` – `DND_TYPES`, `NOTES_TYPES`, `TEMPLATES`, `ADDED_TYPES`/`PRESET_REVISION` | Typen, Felder, Ordner, Vorlagen je Vorlage | Inhalt der mitgelieferten Blueprints `dnd` und `notes` |
| `curator/curator.ts` – `systemPrompt()` mit Zweig `profile === 'dnd'` | Zwei feste Anweisungstexte | Aus dem Blueprint zusammengesetzt (allgemeiner Rahmen + Regeln des Blueprints) |
| Extraktions-Schema (`entities`, `events`, `quests`, `facts`, `relations`, `rooms`) | D&D-Begriffe fest verdrahtet | **Bausteine**, die ein Blueprint ein- oder ausschaltet und Typen zuordnet |
| Abschnittsnamen („Aus den Sessions“, „Fortschritt“, „Räume“, „Beziehungen“) | Konstanten | Im Blueprint festgelegt |
| D&D-Sonderfunktionen: Kampagnen, Sichtbarkeit DM/Spieler, Räume, Spieler-Recaps | Immer an bei `profile: dnd` | **Fähigkeiten** (`features`) des Blueprints |
| Chat: Zeitlinie (Sessions, Skripte, Chronik), Quest-Status | Typnamen `session`, `script`, `quest` fest | Rollen im Blueprint: „Verlauf“, „Vorbereitung“, „Vorhaben mit Status“ |
| Kampagnenseite, Spieler-Ansicht | D&D-only | Nur sichtbar, wenn der Blueprint `campaigns` bzw. `visibility` hat |

## Format eines Blueprints

Datei im Vault: `.basalt/blueprint.md` (versioniert mit git wie alles andere). Mitgelieferte Blueprints liegen im
Programm und werden beim Anlegen in den Vault kopiert.

```markdown
---
blueprint: besprechungen
name: Besprechungen
version: 1
features: [tasks, relations]        # weitere: campaigns, visibility, rooms, timeline
types:
  meeting:  { label: Besprechung, folder: "Besprechungen/{year}", template: meeting,
              fields: [date: datetime, participants: list, source: text] }
  person:   { label: Person, folder: Personen, fields: [organization: text, role: text, email: text] }
  decision: { label: Entscheidung, folder: Entscheidungen, fields: [date: date, meeting: link(meeting)] }
  task:     { label: Aufgabe, folder: Aufgaben, fields: [status: select(offen, erledigt), due: date, owner: link(person)] }
roles:                              # wofür Kurator, Chat und Kalender welche Typen nehmen
  source: meeting                   # Texte aus dem Eingang werden zu …
  timeline: meeting                 # „Was ist zuletzt passiert?“
  tasks: task                       # Vorhaben mit Status (bei D&D: quest)
curator:
  extract: [entities, events, tasks, facts, relations]
  entity_types: [person, decision]
  sections: { mentions: "Erwähnungen", progress: "Verlauf" }
  auto_apply: [create_entity, append_block, add_mention]
  review: [update_property, merge_entities, contradiction]
---

## Kurator-Regeln

- Teilnehmende einer Besprechung als **Person** anlegen; Rolle/Organisation nur, wenn genannt.
- Jede getroffene Entscheidung als eigener Eintrag **Entscheidung** mit Datum und Verweis auf die Besprechung.
- Aufgaben mit Verantwortlichen (`owner`) und Fälligkeit; „bis Freitag“ in ein Datum umrechnen.
- Offene Punkte unter „Offen“ in der Besprechung sammeln, nicht als Aufgabe.

## Beispiele

(optional: kurze Beispieltexte mit erwartetem Ergebnis – helfen kleinen Modellen)
```

- **YAML-Kopf**: alles, was das Programm auswerten muss (Typen, Rollen, Bausteine, Freigaben).
- **„Kurator-Regeln“**: Klartext, der wörtlich in die Anweisung an das LLM geht – das ist der Teil, den man ohne
  Programmierkenntnisse anpasst. Länge wird begrenzt (kleine Modelle, Kontextbudget).
- **„Beispiele“**: optional, werden nur mitgeschickt, wenn Platz ist.

## Freier Vault

- Nur der Typ „Notiz“; Ordner frei wählbar, Eigenschaften frei (ohne Definition).
- Neue Notiz: Titel → schreiben, kein Typ-Dialog.
- Kurator wahlweise aus oder im Modus **„nur verknüpfen“**: erkennt Erwähnungen vorhandener Notizen und setzt
  Links/Rückverweise, legt aber nichts an.
- Kalender, Aufgaben/Checklisten, Chat, Heute, CalDAV funktionieren trotzdem (Datumsfelder werden erkannt, wenn
  vorhanden).
- Ein freier Vault kann später einen Blueprint bekommen (und umgekehrt).

## Releases

1. **Freier Vault** – Vault-Art „Frei“, Typ-Dialog überspringbar, Ordner unabhängig vom Typ, Kurator-Modus
   „nur verknüpfen“. Klein, sofort nützlich für Alltagsnotizen.
2. **Blueprint-Format ohne Verhaltensänderung** – Loader für `.basalt/blueprint.md`; `dnd` und `notes` werden als
   Blueprints ausgeliefert, bestehende `vault.yaml` werden einmalig übersetzt (wie heute `preset_revision`).
   Abnahme: alle bestehenden Tests unverändert grün.
3. **Kurator aus dem Blueprint** – Anweisung aus Rahmen + Regeln + Bausteinen zusammensetzen, Extraktions-Schema je
   Baustein, Rollen statt fester Typnamen in Kurator und Chat. Neuer Blueprint „Besprechungen“ als Beweis, dass ein
   zweites Regelwerk ohne Code-Änderung funktioniert.
4. **Oberfläche** – Auswahl beim Anlegen (Frei / Blueprint), Blueprint-Editor (Formular für Typen + Textfeld für
   Regeln, daneben die Rohdatei), Export/Import als Datei, „Blueprint aus diesem Vault ableiten“, Probelauf
   (Trockenlauf des Kurators mit einem Beispieltext gegen die geänderten Regeln).

## Risiken

- **Kleine Modelle**: freie Regeltexte verwässern die Anweisung. Gegenmittel: Rahmen bleibt fest und knapp,
  Regeln werden begrenzt, Beispiele nur bei Platz; Probelauf im Editor.
- **D&D-Rückfälle**: viele Sonderfälle (Räume, Spieler-Recaps, Duplikat-Regeln) hängen am Profil. Release 2 und 3
  müssen gegen die bestehenden Tests laufen, nicht gegen neue.
- **Versionierung**: Blueprints entwickeln sich weiter (neue Typen). Mitgelieferte Blueprints bekommen eine
  Version; Vaults übernehmen Neuerungen wie heute über `preset_revision`, eigene Änderungen bleiben erhalten.

## Offene Fragen

- Sollen Blueprints zwischen Vaults **geteilt** werden (eine Datei für mehrere Vaults) oder immer als Kopie im Vault
  liegen? Vorschlag: Kopie, mit Hinweis „Vorlage hat eine neuere Version“.
- Welche Blueprints außer D&D und Besprechungen sollen mitkommen (Projekte? Forschung/Lesen? Haushalt?)
- Darf ein Blueprint auch Chat-Verhalten festlegen (z. B. eigene Beispielfragen, eigene Zeitlinien-Regeln)?
