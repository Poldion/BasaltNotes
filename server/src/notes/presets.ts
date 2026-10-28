export type PropType = 'text' | 'number' | 'date' | 'datetime' | 'select' | 'link' | 'list' | 'players' | 'boolean' | 'url'

export interface PropDef {
  name: string
  label: string
  type: PropType
  options?: string[]
  /** Für Link-Felder: erlaubte Zieltypen */
  link_types?: string[]
}

export interface TypeDef {
  folder?: string
  template?: string
  single_note?: string
  label?: string
  /** Name des Abschnitts, in den der Kurator schreibt */
  section?: string
  properties?: PropDef[]
  /** Standardwerte für neue Notizen dieses Typs (z. B. visibility: dm) */
  defaults?: Record<string, unknown>
}

export interface CuratorConfig {
  enabled: boolean
  auto_apply: string[]
  review: string[]
  min_confidence_auto: number
  learn_aliases: boolean
  section: string
  profile: 'dnd' | 'notes'
  /** full = mit LLM einsortieren und anlegen, link = nur Erwähnungen vorhandener Notizen verlinken (ohne LLM) */
  mode?: 'full' | 'link'
}

export interface VaultConfig {
  name: string
  preset?: string
  types: Record<string, TypeDef>
  curator: CuratorConfig
}

const P = {
  campaign: { name: 'campaign', label: 'Kampagne', type: 'link', link_types: ['campaign'] } as PropDef,
  status: (options: string[]): PropDef => ({ name: 'status', label: 'Status', type: 'select', options }),
  attitude: { name: 'attitude', label: 'Haltung', type: 'select', options: ['freundlich', 'neutral', 'feindlich'] } as PropDef,
}

export const DND_TYPES: Record<string, TypeDef> = {
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

export const NOTES_TYPES: Record<string, TypeDef> = {
  note: { label: 'Notiz', folder: 'Notizen', properties: [] },
  meeting: {
    label: 'Besprechung',
    folder: 'Besprechungen',
    template: 'meeting',
    properties: [
      { name: 'date', label: 'Datum', type: 'datetime' },
      { name: 'participants', label: 'Teilnehmende', type: 'list' },
      { name: 'source', label: 'Quelle', type: 'text' },
      { name: 'transcript_url', label: 'Transkript', type: 'url' },
    ],
  },
  person: {
    label: 'Person',
    folder: 'Personen',
    template: 'person',
    properties: [
      { name: 'organization', label: 'Organisation', type: 'text' },
      { name: 'role', label: 'Rolle', type: 'text' },
      { name: 'email', label: 'E-Mail', type: 'text' },
    ],
  },
  project: {
    label: 'Projekt',
    folder: 'Projekte',
    template: 'project',
    properties: [P.status(['geplant', 'aktiv', 'pausiert', 'abgeschlossen']), { name: 'due', label: 'Fällig', type: 'date' }],
  },
  journal: {
    label: 'Tagebuch',
    folder: 'Tagebuch/{year}',
    template: 'journal',
    properties: [
      { name: 'date', label: 'Datum', type: 'date' },
      { name: 'mood', label: 'Stimmung', type: 'select', options: ['großartig', 'gut', 'okay', 'schlecht', 'mies'] },
    ],
  },
  task: {
    label: 'Aufgabe',
    folder: 'Aufgaben',
    template: 'task',
    properties: [
      P.status(['offen', 'erledigt']),
      { name: 'due', label: 'Fällig', type: 'datetime' },
      { name: 'priority', label: 'Priorität', type: 'select', options: ['hoch', 'mittel', 'niedrig'] },
      { name: 'project', label: 'Projekt', type: 'link', link_types: ['project'] },
    ],
  },
  list: {
    label: 'Liste',
    folder: 'Listen',
    template: 'list',
    properties: [{ name: 'category', label: 'Art', type: 'select', options: ['Einkauf', 'To-do', 'Packliste', 'Sonstiges'] }],
  },
  event: {
    label: 'Termin',
    folder: 'Termine/{year}',
    template: 'event',
    properties: [
      { name: 'start', label: 'Beginn', type: 'datetime' },
      { name: 'end', label: 'Ende', type: 'datetime' },
      { name: 'all_day', label: 'Ganztägig', type: 'boolean' },
      { name: 'location', label: 'Ort', type: 'text' },
      { name: 'participants', label: 'Teilnehmende', type: 'list' },
      { name: 'recurrence', label: 'Wiederholung', type: 'select', options: ['keine', 'täglich', 'wöchentlich', 'monatlich', 'jährlich'] },
      { name: 'until', label: 'Wiederholen bis', type: 'date' },
    ],
  },
  recipe: {
    label: 'Rezept',
    folder: 'Rezepte',
    template: 'recipe',
    properties: [
      { name: 'category', label: 'Kategorie', type: 'select', options: ['Frühstück', 'Hauptgericht', 'Beilage', 'Salat', 'Suppe', 'Dessert', 'Backen', 'Getränk', 'Snack'] },
      { name: 'servings', label: 'Portionen', type: 'number' },
      { name: 'time', label: 'Zeit', type: 'text' },
      { name: 'source', label: 'Quelle', type: 'url' },
    ],
  },
  idea: {
    label: 'Idee',
    folder: 'Ideen',
    template: 'idea',
    properties: [P.status(['neu', 'in Arbeit', 'umgesetzt', 'verworfen'])],
  },
  bookmark: {
    label: 'Lesezeichen',
    folder: 'Lesezeichen',
    template: 'bookmark',
    properties: [
      { name: 'url', label: 'Adresse', type: 'url' },
      { name: 'category', label: 'Kategorie', type: 'text' },
    ],
  },
  howto: { label: 'Anleitung', folder: 'Anleitungen', template: 'howto', properties: [] },
}

/** Mitgelieferte Typen je Vorlage (zum Kennzeichnen in der Oberfläche) */
export const PRESET_TYPES: Record<string, Record<string, TypeDef>> = {}

/** Stand der Vorlagen – ältere Vaults bekommen neue Standardtypen beim Öffnen nachgerüstet */
export const PRESET_REVISION = 4
/** Typen, die mit einer Revision hinzugekommen sind */
export const ADDED_TYPES: Record<number, Record<string, string[]>> = {
  2: { dnd: ['script'] },
  3: { dnd: ['monster'] },
  4: { notes: ['journal', 'task', 'list', 'event', 'recipe', 'idea', 'bookmark', 'howto'] },
}

export const COMMON_PROPS: PropDef[] = [
  { name: 'aliases', label: 'Aliasse', type: 'list' },
  { name: 'tags', label: 'Tags', type: 'list' },
  { name: 'visibility', label: 'Sichtbarkeit', type: 'select', options: ['dm', 'players'] },
]

export const DEFAULT_CURATOR: CuratorConfig = {
  enabled: true,
  auto_apply: ['create_entity', 'append_block', 'add_alias', 'add_mention'],
  review: ['update_property', 'merge_entities', 'contradiction', 'delete', 'update_quest'],
  min_confidence_auto: 0.8,
  learn_aliases: true,
  section: 'Aus den Sessions',
  profile: 'dnd',
}

/** Ordnernamen der Vorlagen für Vaults, die auf Englisch angelegt werden (Platzhalter bleiben) */
const EN_FOLDERS: Record<string, string> = {
  Charaktere: 'Characters',
  Orte: 'Locations',
  Fraktionen: 'Factions',
  Gegenstände: 'Items',
  Skripte: 'Scripts',
  Notizen: 'Notes',
  Besprechungen: 'Meetings',
  Personen: 'People',
  Projekte: 'Projects',
  Tagebuch: 'Journal',
  Aufgaben: 'Tasks',
  Listen: 'Lists',
  Termine: 'Events',
  Rezepte: 'Recipes',
  Ideen: 'Ideas',
  Lesezeichen: 'Bookmarks',
  Anleitungen: 'How-tos',
}

export function localizedFolder(folder: string | undefined, lang: 'de' | 'en'): string | undefined {
  if (lang !== 'en' || !folder) return folder
  return folder
    .split('/')
    .map((seg) => EN_FOLDERS[seg] ?? seg)
    .join('/')
}

/** Freier Vault: nur „Notiz“ */
export const EMPTY_TYPES: Record<string, TypeDef> = { note: { label: 'Notiz', folder: '', properties: [] } }

export function presetConfig(name: string, preset: string, lang: 'de' | 'en' = 'de'): VaultConfig {
  const cfg = presetConfigDe(name, preset)
  if (lang === 'de') return cfg
  return { ...cfg, types: Object.fromEntries(Object.entries(cfg.types).map(([k, t]) => [k, { ...t, folder: localizedFolder(t.folder, lang) }])) }
}

function presetConfigDe(name: string, preset: string): VaultConfig {
  if (preset === 'dnd') return { name, preset, types: DND_TYPES, curator: { ...DEFAULT_CURATOR } }
  if (preset === 'notes')
    return { name, preset, types: NOTES_TYPES, curator: { ...DEFAULT_CURATOR, section: 'Erwähnungen', profile: 'notes' } }
  // Freier Vault: nur „Notiz“, Ordner frei, Kurator verknüpft nur (ohne LLM)
  return { name, preset: 'empty', types: EMPTY_TYPES, curator: { ...DEFAULT_CURATOR, section: 'Erwähnungen', profile: 'notes', mode: 'link' } }
}

/** Kompakte vault.yaml (Eigenschaften der Standardtypen stehen im Code und müssen nicht in der Datei stehen). */
export function presetYaml(cfg: VaultConfig): Record<string, any> {
  const types: Record<string, any> = {}
  for (const [k, t] of Object.entries(cfg.types)) {
    const { properties: _p, label: _l, ...rest } = t
    types[k] = rest
  }
  return { name: cfg.name, preset: cfg.preset, preset_revision: PRESET_REVISION, types, curator: cfg.curator }
}

const H = '# {{title}}\n\n'
export const TEMPLATES: Record<string, string> = {
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
  meeting: `${H}## Zusammenfassung\n\n## Aufgaben\n\n## Termine\n`,
  person: `${H}## Notizen\n\n## Erwähnungen\n`,
  project: `${H}## Ziel\n\n## Aufgaben\n\n## Erwähnungen\n`,
  journal: `${H}## Heute\n\n## Gedanken\n\n## Dankbar für\n`,
  task: `${H}## Details\n\n## Teilschritte\n\n- [ ] \n`,
  list: `${H}- [ ] \n`,
  event: `${H}## Notizen\n`,
  recipe: `${H}## Zutaten\n\n- \n\n## Zubereitung\n\n1. \n\n## Notizen\n`,
  idea: `${H}## Worum geht es?\n\n## Nächste Schritte\n`,
  bookmark: `${H}## Warum gemerkt?\n`,
  howto: `${H}## Schritte\n\n1. \n\n## Hinweise\n`,
}

PRESET_TYPES.dnd = DND_TYPES
PRESET_TYPES.notes = NOTES_TYPES
PRESET_TYPES.empty = EMPTY_TYPES
export const PROP_TYPES: PropType[] = ['text', 'number', 'date', 'datetime', 'select', 'link', 'list', 'players', 'boolean', 'url']
