import type { PresetDef, PropDef } from '@basaltnotes/plugin-sdk'
import { NOTES, EXAMPLE_NAME } from './example.js'

const P = {
  campaign: { name: 'campaign', label: 'Kampagne', type: 'link', link_types: ['campaign'] } as PropDef,
  status: (options: string[]): PropDef => ({ name: 'status', label: 'Status', type: 'select', options }),
  attitude: { name: 'attitude', label: 'Haltung', type: 'select', options: ['freundlich', 'neutral', 'feindlich'] } as PropDef,
}

export const DND_TYPES: PresetDef['types'] = {
  campaign: {
    label: 'Kampagne',
    folder: '{title}',
    template: 'campaign',
    properties: [
      { name: 'system', label: 'System', type: 'text' },
      P.status(['aktiv', 'pausiert', 'beendet']),
      { name: 'dm', label: 'Spielleitung', type: 'text' },
      { name: 'players', label: 'Spielende', type: 'players' },
    ],
  },
  session: {
    label: 'Session',
    folder: '{campaign}/Sessions',
    template: 'session',
    properties: [
      P.campaign,
      { name: 'number', label: 'Nummer', type: 'number' },
      { name: 'date', label: 'Datum', type: 'datetime' },
      { name: 'players', label: 'Spielende', type: 'players' },
      { name: 'source', label: 'Quelle', type: 'text' },
      { name: 'transcript_url', label: 'Transkript', type: 'url' },
    ],
  },
  character: {
    label: 'Charakter',
    folder: '{campaign}/Charaktere',
    template: 'character',
    properties: [
      P.campaign,
      { name: 'player', label: 'Spieler:in', type: 'text' },
      { name: 'class', label: 'Klasse', type: 'text' },
      { name: 'race', label: 'Volk', type: 'text' },
      P.status(['lebendig', 'tot', 'verschollen']),
    ],
  },
  npc: {
    label: 'NPC',
    folder: '{campaign}/NPCs',
    template: 'npc',
    properties: [
      P.campaign,
      { name: 'role', label: 'Rolle', type: 'text' },
      { name: 'faction', label: 'Fraktion', type: 'link', link_types: ['faction'] },
      P.attitude,
      P.status(['lebendig', 'tot', 'verschollen', 'unbekannt']),
      { name: 'location', label: 'Ort', type: 'link', link_types: ['location'] },
    ],
  },
  location: {
    label: 'Ort',
    folder: '{campaign}/Orte',
    template: 'location',
    properties: [P.campaign, { name: 'region', label: 'Region', type: 'text' }, { name: 'parent', label: 'Liegt in', type: 'link', link_types: ['location'] }],
  },
  faction: {
    label: 'Fraktion',
    folder: '{campaign}/Fraktionen',
    template: 'faction',
    properties: [P.campaign, { name: 'leader', label: 'Anführung', type: 'link', link_types: ['npc', 'character'] }, P.attitude],
  },
  monster: {
    label: 'Monster',
    folder: '{campaign}/Monster',
    template: 'monster',
    properties: [
      P.campaign,
      { name: 'creature_type', label: 'Kreaturtyp', type: 'text' },
      { name: 'cr', label: 'Herausforderungsgrad', type: 'text' },
      { name: 'ac', label: 'RK', type: 'number' },
      { name: 'hp', label: 'TP', type: 'text' },
      P.status(['lebendig', 'besiegt', 'geflohen', 'unbekannt']),
      { name: 'location', label: 'Ort', type: 'link', link_types: ['location'] },
    ],
  },
  item: {
    label: 'Gegenstand',
    folder: '{campaign}/Gegenstände',
    template: 'item',
    properties: [
      P.campaign,
      { name: 'owner', label: 'Besitz', type: 'link', link_types: ['npc', 'character'] },
      { name: 'rarity', label: 'Seltenheit', type: 'select', options: ['gewöhnlich', 'ungewöhnlich', 'selten', 'sehr selten', 'legendär', 'Artefakt'] },
      { name: 'value', label: 'Wert', type: 'text' },
    ],
  },
  quest: {
    label: 'Quest',
    folder: '{campaign}/Quests',
    template: 'quest',
    properties: [P.campaign, P.status(['offen', 'erledigt', 'gescheitert']), { name: 'giver', label: 'Auftrag von', type: 'link', link_types: ['npc', 'character', 'faction'] }],
  },
  lore: { label: 'Lore', folder: '{campaign}/Lore', template: 'lore', properties: [P.campaign] },
  script: {
    label: 'Skript (Vorbereitung)',
    folder: '{campaign}/Skripte',
    template: 'script',
    defaults: { visibility: 'dm', status: 'geplant' },
    properties: [
      P.campaign,
      P.status(['geplant', 'gespielt', 'verworfen']),
      { name: 'planned_for', label: 'Geplant für', type: 'date' },
      { name: 'session', label: 'Gespielt in', type: 'link', link_types: ['session'] },
    ],
  },
  fact: { label: 'Fakten', folder: '{campaign}', single_note: 'Gesetzte Fakten', properties: [P.campaign] },
  note: { label: 'Notiz', folder: '', properties: [] },
}

const H = '# {{title}}\n\n'

export const DND_PRESET: PresetDef = {
  id: 'dnd',
  label: 'D&D',
  description: 'Kampagnen, Sessions, NPCs, Orte, Quests',
  types: DND_TYPES,
  templates: {
    campaign: `${H}## Übersicht\n\n## Hausregeln\n`,
    session: `${H}## Was bisher geschah\n\n## Ereignisse\n`,
    character: `${H}## Hintergrund\n\n## Aus den Sessions\n`,
    npc: `${H}## Beschreibung\n\n## Motive (DM)\n\n## Aus den Sessions\n`,
    location: `${H}## Beschreibung\n\n## Bewohner\n\n## Aus den Sessions\n`,
    faction: `${H}## Ziele\n\n## Mitglieder\n\n## Aus den Sessions\n`,
    monster: `${H}## Beschreibung\n\n## Werte\n\n## Taktik\n\n## Beute\n\n## Aus den Sessions\n`,
    item: `${H}## Wirkung\n\n## Herkunft\n\n## Aus den Sessions\n`,
    quest: `${H}## Ziel\n\n## Hinweise\n\n## Fortschritt\n`,
    lore: `${H}`,
    script: `${H}## Ziel des Abends\n\n## Szenen\n\n## NPCs & Orte\n\n## Geheimnisse (DM)\n\n## Notizen nach dem Spiel\n`,
  },
  curator: { section: 'Aus den Sessions', profile: 'dnd' },
  added_types: { 2: ['script'], 3: ['monster'] },
  folders_en: { Charaktere: 'Characters', Orte: 'Locations', Fraktionen: 'Factions', Gegenstände: 'Items', Skripte: 'Scripts' },
  example: {
    name: EXAMPLE_NAME,
    description: 'Eine kleine, erfundene D&D-Kampagne („Die Nebelküste“) mit Sessions, NPCs, Orten und Quests – zum Ausprobieren von Links, Graph und Kampagnenseite. Lässt sich später einfach löschen.',
    notes: NOTES,
  },
}
