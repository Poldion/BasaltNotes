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
  /** Regelwerk des Kurators; Plugins können eigene mitbringen */
  profile: string
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
  status: (options: string[]): PropDef => ({ name: 'status', label: 'Status', type: 'select', options }),
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

/** Stand der Vorlagen – ältere Vaults bekommen neue Standardtypen beim Öffnen nachgerüstet */
export const PRESET_REVISION = 4
/** Typen, die mit einer Revision hinzugekommen sind */
const NOTES_ADDED: Record<number, string[]> = {
  4: ['journal', 'task', 'list', 'event', 'recipe', 'idea', 'bookmark', 'howto'],
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
  section: 'Erwähnungen',
  profile: 'notes',
}

/** Ordnernamen der Vorlagen für Vaults, die auf Englisch angelegt werden (Platzhalter bleiben) */
const EN_FOLDERS: Record<string, string> = {
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

export function localizedFolder(folder: string | undefined, lang: 'de' | 'en', extra: Record<string, string> = {}): string | undefined {
  if (lang !== 'en' || !folder) return folder
  return folder
    .split('/')
    .map((seg) => extra[seg] ?? EN_FOLDERS[seg] ?? seg)
    .join('/')
}

/** Freier Vault: nur „Notiz“ */
export const EMPTY_TYPES: Record<string, TypeDef> = { note: { label: 'Notiz', folder: '', properties: [] } }

/** Vorlage für neue Vaults: im Kern (notes, empty) oder aus einem Plugin */
export interface PresetDef {
  id: string
  /** Name in der Auswahl */
  label: string
  /** Längere Beschreibung für die Auswahl */
  description?: string
  types: Record<string, TypeDef>
  /** Vorlagentexte, Schlüssel wie TypeDef.template */
  templates?: Record<string, string>
  curator?: Partial<CuratorConfig>
  /** Typen, die mit einer Revision hinzugekommen sind */
  added_types?: Record<number, string[]>
  /** Englische Ordnernamen für Vaults, die auf Englisch angelegt werden */
  folders_en?: Record<string, string>
  /** Beispiel-Vault zum Ausprobieren */
  example?: { name: string; description?: string; notes: { type: string; title: string; frontmatter?: Record<string, unknown>; body: string }[] }
  /** Plugin, das die Vorlage mitbringt (setzt der Kern) */
  plugin?: string
}

const registry = new Map<string, PresetDef>()

/** Vorlage bekannt machen (gleiche id ersetzt die vorige, z. B. beim erneuten Laden) */
export function registerPreset(def: PresetDef) {
  registry.set(def.id, def)
}

export function getPreset(id: string | undefined): PresetDef | undefined {
  return id ? registry.get(id) : undefined
}

export function listPresets(): PresetDef[] {
  return [...registry.values()]
}

/** Vorlagentext aus allen bekannten Vorlagen */
export function templateFor(name: string): string | undefined {
  if (TEMPLATES[name]) return TEMPLATES[name]
  for (const def of registry.values()) if (def.templates?.[name]) return def.templates[name]
  return undefined
}

export function presetConfig(name: string, preset: string, lang: 'de' | 'en' = 'de'): VaultConfig {
  const def = registry.get(preset) ?? registry.get('empty')!
  const types = lang === 'de' ? def.types : Object.fromEntries(Object.entries(def.types).map(([k, t]) => [k, { ...t, folder: localizedFolder(t.folder, lang, def.folders_en) }]))
  return { name, preset: def.id, types, curator: { ...DEFAULT_CURATOR, ...def.curator } }
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

registerPreset({ id: 'empty', label: 'Frei', description: 'Nur Notizen, Ordner nach Wahl', types: EMPTY_TYPES, curator: { mode: 'link' } })
registerPreset({ id: 'notes', label: 'Alltag', description: 'Tagebuch, Aufgaben, Termine …', types: NOTES_TYPES, added_types: NOTES_ADDED })

export const PROP_TYPES: PropType[] = ['text', 'number', 'date', 'datetime', 'select', 'link', 'list', 'players', 'boolean', 'url']
