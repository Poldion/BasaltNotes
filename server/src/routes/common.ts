import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AppConfig } from '../config.js'
import type { Auth, Scope } from '../auth.js'
import { requireScope, effectiveVisibility, grantFor, grantRestricted } from '../auth.js'
import type { Db } from '../db.js'
import type { EventBus } from '../events.js'
import type { JobQueue } from '../jobs.js'
import type { Webhooks } from '../webhooks.js'
import type { VaultManager } from '../notes/vaults.js'
import type { Vault, Note } from '../notes/vault.js'
import { Search, restrictionAllows, hasArea, type Restriction } from '../notes/search.js'
import { Renderer } from '../notes/render.js'
import { listBlocks, stripDmBlocks } from '../notes/markdown.js'
import type { LlmClient } from '../curator/llm.js'
import type { Curator } from '../curator/curator.js'
import type { Inbox } from '../curator/inbox.js'
import type { ChatService } from '../chat/chat.js'
import type { PluginManager } from '../plugins/manager.js'
import { ApiError, notFound } from '../lib/errors.js'

export interface Services {
  config: AppConfig
  db: Db
  events: EventBus
  vaults: VaultManager
  search: Search
  auth: Auth
  jobs: JobQueue
  webhooks: Webhooks
  llm: LlmClient
  curator: Curator
  inbox: Inbox
  chat: ChatService
  plugins?: PluginManager
  version: string
}

export type Register = (app: FastifyInstance, s: Services) => void

/** Vault aus der Route holen und Berechtigung prüfen. */
export function vaultFor(req: FastifyRequest, s: Services, scope: Scope): Vault {
  const id = (req.params as any).vault as string
  const v = s.vaults.get(id)
  requireScope(req, scope, v.id)
  return v
}

export function visibilityOf(req: FastifyRequest): 'dm' | 'players' | undefined {
  return effectiveVisibility(req, (req.query as any)?.visibility)
}

/**
 * Was der Zugang in diesem Vault sehen darf: Sichtbarkeit (Spieler) und Bereich
 * (Kampagne/Ordner/Typen aus der Freigabe bzw. Kampagne eines Spieler-Kontos).
 */
export function accessOf(req: FastifyRequest, vaultId: string): Restriction {
  const visibility = visibilityOf(req)
  const g = grantFor(req, vaultId)
  if (g) return { visibility, campaign: g.campaign ?? null, shared: g.shared !== false, folders: g.folders, types: g.types }
  const camp = req.principal?.campaign
  return camp ? { visibility, campaign: camp, shared: true } : { visibility }
}

/** Ist der Zugang in diesem Vault auf einen Bereich beschränkt? */
export function isAreaRestricted(req: FastifyRequest, vaultId: string): boolean {
  return hasArea(accessOf(req, vaultId))
}

/** Notiz lesen und Sichtbarkeit/Bereich prüfen (außerhalb des Bereichs: „nicht gefunden“). */
export function noteFor(req: FastifyRequest, v: Vault, id: string): Note {
  const note = v.getNote(id)
  if (!restrictionAllows(accessOf(req, v.id), note)) throw notFound('Notiz')
  return note
}

/** Schreibzugriff: Ergebnis muss im freigegebenen Bereich liegen. */
export function assertInArea(req: FastifyRequest, v: Vault, note: { campaign: string | null; path: string; type: string }) {
  const { visibility: _v, ...area } = accessOf(req, v.id)
  if (!restrictionAllows(area, { ...note, visibility: null })) throw new ApiError('forbidden', 'Außerhalb des freigegebenen Bereichs (Kampagne/Ordner/Typ) dieses Zugangs.')
}

/** Renderer-Optionen für den Zugang */
export function renderAccess(req: FastifyRequest, v: Vault): { visibility?: 'dm' | 'players'; allow?: (n: { campaign: string | null; path: string; type: string; visibility: string | null }) => boolean } {
  const access = accessOf(req, v.id)
  return { visibility: visibilityOf(req), ...(hasArea(access) ? { allow: (n) => restrictionAllows(access, n) } : {}) }
}

/**
 * Was Zugänge mit Bereichs-Einschränkung überhaupt aufrufen dürfen. Alles andere (Papierkorb, Verlauf, Export,
 * Kurator, Eingang, Anhänge, Ordner …) könnte Inhalte außerhalb des Bereichs zeigen oder ändern und ist gesperrt.
 */
const AREA_READ = new Set([
  'GET /vaults',
  'GET /vaults/:vault',
  'GET /vaults/:vault/types',
  'GET /vaults/:vault/tree',
  'GET /vaults/:vault/notes',
  'GET /vaults/:vault/notes/by-path',
  'GET /vaults/:vault/notes/by-title',
  'GET /vaults/:vault/notes/:id',
  'GET /vaults/:vault/notes/:id/backlinks',
  'GET /vaults/:vault/notes/:id/links',
  'GET /vaults/:vault/notes/:id/html',
  'GET /vaults/:vault/notes/:id/tasks',
  'POST /vaults/:vault/render',
  'GET /vaults/:vault/search',
  'POST /vaults/:vault/query',
  'GET /vaults/:vault/resolve',
  'GET /vaults/:vault/names',
  'GET /vaults/:vault/graph',
  'GET /plugins',
  'POST /vaults/:vault/chat',
  'POST /vaults/:vault/chat/context',
  'GET /health',
  'GET /auth/me',
  'GET /openapi.json',
])
const AREA_WRITE = new Set([
  'POST /vaults/:vault/notes',
  'PUT /vaults/:vault/notes/:id',
  'PATCH /vaults/:vault/notes/:id',
  'DELETE /vaults/:vault/notes/:id',
  'PUT /vaults/:vault/notes/:id/blocks/:key',
  'DELETE /vaults/:vault/notes/:id/blocks/:key',
  'POST /vaults/:vault/notes/:id/tasks/:index',
  'POST /vaults/:vault/notes/:id/link',
  'POST /vaults/:vault/journal/today',
  'POST /vaults/:vault/capture',
])

/** Plugins geben eigene Endpunkte für Zugänge mit Bereich frei (Pfad ohne /api/v1) */
export function allowAreaRoute(method: string, url: string, access: 'read' | 'write') {
  ;(access === 'write' ? AREA_WRITE : AREA_READ).add(`${method.toUpperCase()} ${url}`)
}

/** Prüft die Positivliste für Zugänge, deren Freigabe auf einen Bereich beschränkt ist. */
export function checkAreaRoute(req: FastifyRequest, prefix: string) {
  const p = req.principal
  if (!p?.grants?.some((g) => grantRestricted(g))) return
  const url = (req.routeOptions?.url ?? '').replace(prefix, '') || '/'
  const key = `${req.method} ${url}`
  const vault = (req.params as any)?.vault as string | undefined
  // Notizbuch ohne Bereichs-Einschränkung: volle Lese-/Schreibrechte dort (Scope-Prüfung wie gehabt)
  if (vault && !grantRestricted(p.grants.find((g) => g.vault === vault))) return
  if (AREA_READ.has(key) || AREA_WRITE.has(key)) return
  throw new ApiError('forbidden', 'Dieser Zugang ist auf einen Bereich beschränkt – diese Funktion steht ihm nicht zur Verfügung.')
}

const RESERVED = new Set(['id', 'type', 'title', 'aliases', 'created', 'updated'])

export function noteJson(v: Vault, note: Note, opts: { visibility?: 'dm' | 'players'; fields?: string[]; access?: Restriction } = {}) {
  const players = opts.visibility === 'players'
  // Links auf Notizen außerhalb des Bereichs nicht auflösen (Titel/ID bleiben verborgen)
  const area = opts.access && hasArea(opts.access) ? opts.access : null
  const visibleTarget = (id: string | null) => {
    if (!area || !id) return true
    const t = v.readNote(id)
    return !!t && restrictionAllows(area, t)
  }
  const body = players ? stripDmBlocks(note.body) : note.body
  const frontmatter: Record<string, any> = {}
  for (const [k, val] of Object.entries(note.frontmatter)) if (!RESERVED.has(k)) frontmatter[k] = val instanceof Date ? val.toISOString() : val
  const links = v
    .outgoing(note.id)
    .filter((l) => !players || !l.in_dm_block)
    .map((l) =>
      visibleTarget(l.target_id)
        ? { target_id: l.target_id, text: l.text, target: l.target, heading: l.heading, embed: l.embed, resolved: l.resolved, attachment: l.attachment, type: l.target_type }
        : { target_id: null, text: l.text, target: l.target, heading: l.heading, embed: l.embed, resolved: false, attachment: false, type: null },
    )
  const out: Record<string, any> = {
    id: note.id,
    vault: v.id,
    path: note.path,
    type: note.type,
    title: note.title,
    aliases: note.aliases,
    tags: note.tags,
    campaign: note.campaign,
    visibility: note.visibility,
    frontmatter,
    body,
    blocks: listBlocks(body).map((b) => ({ key: b.key, source_note: b.attrs.source ?? null, visibility: b.attrs.visibility ?? null, updated: b.attrs.updated ?? null })),
    links,
    backlink_count: area ? v.backlinks(note.id).filter((b) => visibleTarget(b.source_id)).length : v.backlinkCount(note.id),
    version: note.version,
    created: note.created,
    updated: note.updated,
  }
  if (!players) out.raw = note.raw
  if (opts.fields?.length) {
    const picked: Record<string, any> = { id: note.id }
    for (const f of opts.fields) if (f in out) picked[f] = out[f]
    return picked
  }
  return out
}

export function renderer(v: Vault) {
  return new Renderer(v)
}

export const T = {
  vaults: ['Vaults'],
  notes: ['Notizen'],
  blocks: ['Verwaltete Bereiche'],
  search: ['Suche & Abfragen'],
  inbox: ['Eingang'],
  curator: ['Kurator'],
  render: ['Darstellung'],
  events: ['Ereignisse & Webhooks'],
  system: ['System'],
}
