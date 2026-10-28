/**
 * Beispiel-Vault zum Ausprobieren: eine kleine, frei erfundene D&D-Kampagne mit Sessions, NPCs, Orten, Quests
 * und Verknüpfungen – damit Graph, Backlinks, Kampagnenseite, Kalender und Chat sofort etwas zeigen.
 */
import type { Vault } from './vault.js'
import type { VaultManager } from './vaults.js'

export const EXAMPLE_VAULT_NAME = 'Beispiel – Die Nebelküste'
const C = 'Die Nebelküste'

interface Seed {
  type: string
  title: string
  fm?: Record<string, unknown>
  body: string
}

const NOTES: Seed[] = [
  {
    type: 'campaign',
    title: C,
    fm: { system: 'D&D 5e', status: 'aktiv', dm: 'Spielleitung', visibility: 'players' },
    body: `# ${C}

## Übersicht

Eine raue Küste, auf der seit Wochen dichter Nebel liegt. Seit das [[Leuchtfeuer von Velm]] erloschen ist, zerschellen
Schiffe an den Klippen vor [[Krähenhafen]]. Die Gruppe soll herausfinden, wer dahintersteckt.

## Hausregeln

- Kritische Treffer: maximaler Schaden plus ein Wurf.
- Inspiration gibt es für gutes Rollenspiel – auch für das Scheitern mit Stil.
`,
  },
  {
    type: 'location',
    title: 'Krähenhafen',
    fm: { region: 'Nebelküste', visibility: 'players' },
    body: `# Krähenhafen

## Beschreibung

Hafenstadt aus schwarzem Stein, eng an die Klippen gebaut. Der Fischmarkt ist laut, die Gassen sind steil.
Die Stadtwache unter [[Hauptmann Oren Valt]] ist überfordert, seit die Schmuggler der [[Schwarze Flut|Schwarzen Flut]]
mutiger werden.

## Bewohner

- [[Mira Kesselbrand]] – Wirtin im [[Zum Rostigen Anker|Rostigen Anker]]
- [[Hauptmann Oren Valt]]
`,
  },
  {
    type: 'location',
    title: 'Zum Rostigen Anker',
    fm: { region: 'Nebelküste', parent: '[[Krähenhafen]]', visibility: 'players' },
    body: `# Zum Rostigen Anker

## Beschreibung

Gasthaus direkt am Kai. Fischsuppe, dünnes Bier, dicke Luft. Treffpunkt der Gruppe; [[Mira Kesselbrand]] hört alles,
was im Hafen geredet wird.
`,
  },
  {
    type: 'location',
    title: 'Leuchtfeuer von Velm',
    fm: { region: 'Nebelküste', visibility: 'players' },
    body: `# Leuchtfeuer von Velm

## Beschreibung

Alter Leuchtturm auf einer Felsnase zwei Stunden nördlich von [[Krähenhafen]]. Seit dem Neumond brennt er nicht mehr.
Der Wärter ist verschwunden.
`,
  },
  {
    type: 'npc',
    title: 'Mira Kesselbrand',
    fm: { role: 'Wirtin', location: '[[Zum Rostigen Anker]]', attitude: 'freundlich', status: 'lebendig', aliases: ['Mira'], visibility: 'players' },
    body: `# Mira Kesselbrand

## Beschreibung

Breitschultrige Halblingsfrau mit Kochlöffel im Gürtel. Kennt jeden Fischer beim Namen und schuldet niemandem etwas.

## Aus den Sessions

- Gab der Gruppe den Hinweis auf die [[Verschwundene Fischer|verschwundenen Fischer]] (Session 1).
`,
  },
  {
    type: 'npc',
    title: 'Hauptmann Oren Valt',
    fm: { role: 'Hauptmann der Stadtwache', location: '[[Krähenhafen]]', attitude: 'neutral', status: 'lebendig', aliases: ['Oren', 'Valt'], visibility: 'players' },
    body: `# Hauptmann Oren Valt

## Beschreibung

Müder Veteran mit grauem Bart. Will Ruhe in der Stadt – und keine Fragen zu seinen Schulden.

## Aus den Sessions

- Hat der Gruppe 50 Goldmünzen geboten, wenn das [[Leuchtfeuer von Velm]] wieder brennt (Session 2).
`,
  },
  {
    type: 'npc',
    title: 'Die Graue Witwe',
    fm: { role: 'Anführerin der Schwarzen Flut', faction: '[[Schwarze Flut]]', attitude: 'feindlich', status: 'lebendig', visibility: 'dm' },
    body: `# Die Graue Witwe

## Beschreibung

Niemand hat ihr Gesicht gesehen. Sie lässt das Leuchtfeuer gelöscht, damit gestrandete Schiffe geplündert werden können.

## Motive (DM)

- Hält den Leuchtturmwärter im Keller des Leuchtturms gefangen.
- [[Hauptmann Oren Valt]] steht in ihrer Schuld – er schaut weg.
`,
  },
  {
    type: 'faction',
    title: 'Schwarze Flut',
    fm: { leader: '[[Die Graue Witwe]]', attitude: 'feindlich', aliases: ['Schwarzen Flut'], visibility: 'players' },
    body: `# Schwarze Flut

## Ziele

Schmuggel an der ganzen Nebelküste; seit dem Nebel auch Strandraub.

## Mitglieder

- Schmuggler im Hafen von [[Krähenhafen]]
`,
  },
  {
    type: 'item',
    title: 'Laterne der Gezeiten',
    fm: { rarity: 'selten', owner: '[[Thalia Dornwind]]', visibility: 'players' },
    body: `# Laterne der Gezeiten

## Wirkung

Leuchtet durch Nebel bis zu 30 m weit. Einmal pro Tag: zeigt die Richtung zum nächsten Ufer.

## Herkunft

Gefunden im Wrack der „Seeschwalbe“ (Session 1).
`,
  },
  {
    type: 'character',
    title: 'Thalia Dornwind',
    fm: { player: 'Beispiel-Spielerin', class: 'Waldläuferin', race: 'Halbelfe', status: 'lebendig', aliases: ['Thalia'], visibility: 'players' },
    body: `# Thalia Dornwind

## Hintergrund

Wuchs bei Fischern an der Küste auf, kennt jede Bucht. Trägt die [[Laterne der Gezeiten]].
`,
  },
  {
    type: 'character',
    title: 'Brok Eisenfaust',
    fm: { player: 'Beispiel-Spieler', class: 'Kleriker', race: 'Zwerg', status: 'lebendig', aliases: ['Brok'], visibility: 'players' },
    body: `# Brok Eisenfaust

## Hintergrund

Priester des Schmiedegottes, auf der Suche nach seinem verschollenen Bruder – einem der [[Verschwundene Fischer|verschwundenen Fischer]].
`,
  },
  {
    type: 'quest',
    title: 'Verschwundene Fischer',
    fm: { status: 'erledigt', giver: '[[Mira Kesselbrand]]', visibility: 'players' },
    body: `# Verschwundene Fischer

## Ziel

Herausfinden, was mit den drei Fischern passiert ist, die im Nebel nicht zurückkamen.

## Fortschritt

- Session 1: Wrack der „Seeschwalbe“ gefunden, die Fischer lebend in einer Höhle befreit. Erledigt.
`,
  },
  {
    type: 'quest',
    title: 'Das erloschene Leuchtfeuer',
    fm: { status: 'offen', giver: '[[Hauptmann Oren Valt]]', visibility: 'players' },
    body: `# Das erloschene Leuchtfeuer

## Ziel

Das [[Leuchtfeuer von Velm]] wieder entzünden und herausfinden, wo der Wärter ist.

## Hinweise

- Fußspuren im Sand führen zur Felsnase.
- Die befreiten Fischer sprechen von Männern mit schwarzen Halstüchern ([[Schwarze Flut]]).
`,
  },
  {
    type: 'session',
    title: 'Session 1 – Nebel über dem Kai',
    fm: { number: 1, date: '2026-10-03T19:00', visibility: 'players' },
    body: `# Session 1 – Nebel über dem Kai

## Ereignisse

Die Gruppe traf sich im [[Zum Rostigen Anker|Rostigen Anker]]. [[Mira Kesselbrand]] erzählte von drei verschwundenen
Fischern. [[Thalia Dornwind]] führte die Gruppe durch den Nebel zum Wrack der „Seeschwalbe“ und fand dort die
[[Laterne der Gezeiten]]. In einer Höhle befreite die Gruppe die Fischer – darunter Broks Bruder.
`,
  },
  {
    type: 'session',
    title: 'Session 2 – Ein Auftrag der Wache',
    fm: { number: 2, date: '2026-10-17T19:00', visibility: 'players' },
    body: `# Session 2 – Ein Auftrag der Wache

## Was bisher geschah

Die Fischer sind zurück, doch der Nebel bleibt.

## Ereignisse

[[Hauptmann Oren Valt]] bot 50 Goldmünzen für das Wiederentzünden des [[Leuchtfeuer von Velm]]. [[Brok Eisenfaust]]
misstraute ihm. Am Abend beobachtete die Gruppe Schmuggler der [[Schwarze Flut|Schwarzen Flut]] am Hafen.
`,
  },
  {
    type: 'script',
    title: 'Vorbereitung Session 3 – Der Leuchtturm',
    fm: { status: 'geplant', planned_for: '2026-10-31', visibility: 'dm' },
    body: `# Vorbereitung Session 3 – Der Leuchtturm

## Ziel des Abends

Die Gruppe erreicht das [[Leuchtfeuer von Velm]] und findet den gefangenen Wärter.

## Szenen

1. Aufstieg über die Felsnase im Nebel
2. Schmuggler im Leuchtturm
3. Der Wärter im Keller – er erkennt [[Hauptmann Oren Valt]] als Verräter

## Geheimnisse (DM)

- [[Die Graue Witwe]] beobachtet alles von einem Boot aus.
`,
  },
]

/** Beispiel-Vault anlegen (Vorlage D&D) und mit Notizen füllen */
export async function createExampleVault(vaults: VaultManager): Promise<Vault> {
  const v = await vaults.create(EXAMPLE_VAULT_NAME, 'dnd')
  for (const n of NOTES) {
    await v.createNote({ type: n.type, title: n.title, frontmatter: { ...(n.type === 'campaign' ? {} : { campaign: C }), ...(n.fm ?? {}) }, body: n.body })
  }
  await v.flushCommit('Beispiel-Vault angelegt')
  return v
}
