/**
 * BasaltNotes Plugin-SDK – Server-Teil.
 *
 * Ein Plugin ist ein Ordner mit `manifest.json`, optional einem Server-Modul (`server`) und einem
 * Oberflächen-Modul (`web`, siehe `@basaltnotes/plugin-sdk/web`). Das Server-Modul exportiert als
 * `default` ein {@link ServerPlugin}.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
// Schema-Felder wie tags/summary (OpenAPI)
import '@fastify/swagger'

export interface PluginManifest {
  /** Kleinbuchstaben, Ziffern, Bindestrich – z. B. "calendar" */
  id: string
  name: string
  version: string
  description?: string
  author?: string
  /** Pfad zum Server-Modul (ESM), relativ zum Plugin-Ordner */
  server?: string
  /** Pfad zum Oberflächen-Modul (ESM, im Browser geladen) */
  web?: string
  /** Pfad zu einer CSS-Datei für die Oberfläche */
  styles?: string
  /** Ohne Eintrag in config.yaml eingeschaltet? (Standard: nein) */
  default_enabled?: boolean
  /** Zusätzliche HTTP-Methoden, die das Plugin braucht (z. B. PROPFIND, REPORT für CalDAV) */
  http_methods?: string[]
  /** Automatisch an, solange ein Vault eine dieser Vorlagen benutzt */
  auto_enable_presets?: string[]
}

export interface PropDef {
  name: string
  label: string
  type: 'text' | 'number' | 'date' | 'datetime' | 'select' | 'link' | 'list' | 'players' | 'boolean' | 'url'
  options?: string[]
  link_types?: string[]
}

export interface TypeDef {
  label?: string
  folder?: string
  template?: string
  properties?: PropDef[]
}

/** Vorlage für neue Vaults */
export interface PresetDef {
  id: string
  label: string
  description?: string
  types: Record<string, TypeDef & { single_note?: string; section?: string; defaults?: Record<string, unknown> }>
  /** Vorlagentexte, Schlüssel wie TypeDef.template */
  templates?: Record<string, string>
  curator?: { section?: string; profile?: string; mode?: 'full' | 'link' }
  /** Typen, die mit einer Revision hinzugekommen sind */
  added_types?: Record<number, string[]>
  /** Englische Ordnernamen */
  folders_en?: Record<string, string>
  /** Beispiel-Vault zum Ausprobieren */
  example?: { name: string; description?: string; notes: { type: string; title: string; frontmatter?: Record<string, unknown>; body: string }[] }
}

export interface NoteRecord {
  id: string
  vault: string
  path: string
  type: string
  title: string
  aliases: string[]
  tags: string[]
  campaign: string | null
  visibility: string | null
  frontmatter: Record<string, any>
  body: string
  raw: string
  version: string
  created: string | null
  updated: string | null
}

export interface VaultApi {
  id: string
  config: { name: string; preset?: string; types: Record<string, TypeDef> }
  readNote(id: string): NoteRecord | null
  getNote(id: string): NoteRecord
  /** Notiz über Titel oder Alias finden */
  resolveName(name: string, opts?: { type?: string; campaign?: string | null }): string | null
  folderFor(type: string, campaign: string | null | undefined, title: string, when?: Date): string
  createNote(input: { type?: string; title: string; frontmatter?: Record<string, any>; body?: string; folder?: string }): Promise<NoteRecord>
  replaceNote(id: string, input: { raw?: string; frontmatter?: Record<string, any>; body?: string }, ifMatch: string | undefined): Promise<NoteRecord>
  patchNote(id: string, input: { frontmatter?: Record<string, any>; remove?: string[]; append?: string | { text: string; heading?: string } }, ifMatch: string | undefined): Promise<NoteRecord>
  renameNote(id: string, input: { title?: string; folder?: string }): Promise<{ note: NoteRecord }>
  deleteNote(id: string): Promise<unknown>
}

export interface DbApi {
  get<T = any>(sql: string, ...params: any[]): T | undefined
  all<T = any>(sql: string, ...params: any[]): T[]
  run(sql: string, ...params: any[]): unknown
}

/** Was ein Zugang sehen darf (Sichtbarkeit + Bereich der Freigabe) */
export interface Restriction {
  visibility?: 'dm' | 'players'
  campaign?: string | null
  shared?: boolean
  folders?: string[]
  types?: string[]
}

export interface TaskItem {
  index: number
  checked: boolean
  text: string
  offset: number
  line: number
}

export type Scope = 'read' | 'write' | 'inbox' | 'curate' | 'admin'

/** Hilfsfunktionen des Kerns – damit Plugins Rechte und Bereiche genauso prüfen wie BasaltNotes selbst */
export interface PluginHelpers {
  /** Vault aus :vault holen und Recht prüfen (wirft 403/404) */
  vaultFor(req: FastifyRequest, scope: Scope): VaultApi
  /** Notiz lesen und Sichtbarkeit/Bereich prüfen (außerhalb: 404) */
  noteFor(req: FastifyRequest, v: VaultApi, id: string): NoteRecord
  requireScope(req: FastifyRequest, scope: Scope, vault?: string): void
  accessOf(req: FastifyRequest, vaultId: string): Restriction
  /** Sicht der Anfrage: 'players' = eingeschränkt */
  visibilityOf(req: FastifyRequest): 'dm' | 'players' | undefined
  slugify(s: string): string
  /** Bereiche mit visibility="dm" entfernen */
  stripDmBlocks(body: string): string
  stripBlockMarkers(body: string): string
  listBlocks(body: string): any[]
  headings(body: string): any[]
  isAreaRestricted(req: FastifyRequest, vaultId: string): boolean
  assertInArea(req: FastifyRequest, v: VaultApi, note: { campaign: string | null; path: string; type: string }): void
  /** SQL-Bedingungen für den Bereich (Alias n), Parameter werden an params angehängt */
  restrictSql(access: Restriction | undefined, params: any[], alias?: string): string
  restrictionAllows(access: Restriction | undefined, note: { campaign?: string | null; path: string; type: string; visibility?: string | null }): boolean
  /** API-Token prüfen (z. B. für Basic-Auth bei CalDAV) und Anmeldung an der Anfrage setzen */
  authenticateToken(req: FastifyRequest, token: string): boolean
  /** JSON lesen mit Ersatzwert */
  json<T>(text: string | null | undefined, fallback: T): T
  /** "[[Ziel|Text]]" → "Ziel" */
  stripLink(v: unknown): string | null
  listTasks(body: string): TaskItem[]
  setTask(body: string, index: number, checked: boolean): string
  appendTask(body: string, text: string, checked?: boolean): string
  /** Fehler im Format der API (wird als {error: {code, message}} beantwortet) */
  error(code: 'not_found' | 'validation_error' | 'forbidden' | 'conflict' | 'unauthorized', message: string, details?: Record<string, unknown>): Error
}

export interface ProfileContext {
  v: VaultApi
  db: DbApi
  slugify(s: string): string
}

/** Regelwerk eines Vaults für Kurator, Eingang und Chat (vault.yaml: curator.profile) */
export interface VaultProfile {
  id: string
  /** Typen, die der Kurator nicht als Einträge erkennt */
  nonEntityTypes?: string[]
  /** Bei widersprüchlichen Typen für denselben Namen gewinnt der frühere */
  entityRank?: string[]
  /** Neue Einträge gehören zur Gruppe des Eingangs (Feld campaign) */
  scoped?: boolean
  /** Es gibt eine eingeschränkte Sicht (Feld visibility, Bereiche mit visibility="dm") */
  restrictedView?: boolean
  systemPrompt?(c: { group: string | null | undefined; types: string; hasType(t: string): boolean; knownNames: string; hint: string }): string
  sourceRules?(note: { type: string }): { hint?: string; restricted?: boolean } | null
  excludedNames?(c: ProfileContext & { frontmatter?: Record<string, any>; group: string | null }): string[]
  defaultInboxType?: string
  resolveGroup?(c: ProfileContext & { name: string | null | undefined }): Promise<string | null>
  inboxFrontmatter?(c: ProfileContext & { type: string; group: string | null; frontmatter: Record<string, any>; isNew: boolean }): void
  documentDefaults?(c: { v: VaultApi; visibility?: 'dm' | 'players' }): { type?: string; visibility?: 'dm' | 'players' }
  /** Worum es im Chat geht („Du beantwortest Fragen zu …“) */
  chatSubject?: string
  typeWords?: Record<string, string[]>
  genericWords?: string[]
}

/** Rolle für Benutzerkonten */
export interface RoleDef {
  id: string
  label: string
  scopes: Scope[]
  /** Nur eingeschränkte Sicht (visibility: players) */
  restricted?: boolean
}

export interface ServerPluginContext {
  id: string
  manifest: PluginManifest
  appVersion: string
  /** Ist das Plugin gerade eingeschaltet? (Endpunkte werden ausgeschaltet automatisch mit 404 beantwortet) */
  isEnabled(): boolean
  /** Eigene Einstellungen des Plugins (in config.yaml unter plugins.<id>.settings) */
  settings: { get(): Record<string, any>; set(values: Record<string, any>): void }
  db: DbApi
  vaults: { list(): VaultApi[]; get(id: string): VaultApi }
  helpers: PluginHelpers
  /**
   * Endpunkt für Zugänge mit Bereichs-Einschränkung freigeben (sonst gesperrt), z. B.
   * allowArea('GET', '/vaults/:vault/calendar', 'read'). Pfad ohne /api/v1.
   */
  allowArea(method: string, url: string, access: 'read' | 'write'): void
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string | Error): void }
}

export interface ServerPlugin {
  /** Vorlagen für neue Vaults */
  presets?: PresetDef[]
  /** Regelwerke für Kurator, Eingang und Chat */
  profiles?: VaultProfile[]
  /** Rollen für Benutzerkonten */
  roles?: RoleDef[]
  /** Endpunkte unter /api/v1 – Anmeldung, CSRF und Freigaben gelten wie für den Kern */
  api?(app: FastifyInstance, ctx: ServerPluginContext): void | Promise<void>
  /** Endpunkte ab / (eigene Anmeldung nötig), z. B. /dav für CalDAV */
  root?(app: FastifyInstance, ctx: ServerPluginContext): void | Promise<void>
}
