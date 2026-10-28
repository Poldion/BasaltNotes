import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireScope, type Scope } from '../auth.js'
import { readFileConfig, updateFileConfig } from '../config.js'
import { json } from '../db.js'
import { ApiError, invalid, notFound } from '../lib/errors.js'
import { appendTask, listTasks, setTask } from '../notes/markdown.js'
import { restrictionAllows, restrictSql } from '../notes/search.js'
import { stripLink } from '../notes/vault.js'
import { accessOf, allowAreaRoute, assertInArea, isAreaRestricted, noteFor, vaultFor, type Services } from '../routes/common.js'

/*
 * Plugins: Ordner mit manifest.json, optional Server-Modul (api/root) und Oberflächen-Modul (web).
 * Mitgelieferte Plugins liegen im Programm (<app>/plugins), eigene unter <data>/plugins.
 * Server-Module werden beim Start geladen; ein-/ausschalten geht ohne Neustart (ausgeschaltet → 404).
 */

export interface PluginManifest {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  server?: string
  web?: string
  styles?: string
  default_enabled?: boolean
  http_methods?: string[]
}

interface ServerModule {
  api?: (app: FastifyInstance, ctx: any) => void | Promise<void>
  root?: (app: FastifyInstance, ctx: any) => void | Promise<void>
}

export interface LoadedPlugin {
  manifest: PluginManifest
  dir: string
  builtin: boolean
  module: ServerModule | null
  error: string | null
  ctx: any
}

const ID_RE = /^[a-z][a-z0-9-]{1,40}$/
const here = path.dirname(fileURLToPath(import.meta.url))
/** Mitgelieferte Plugins: <repo>/plugins (aus server/src bzw. server/dist) */
export const BUILTIN_PLUGIN_DIR = process.env.BUILTIN_PLUGINS_DIR || path.resolve(here, '..', '..', '..', 'plugins')

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

export class PluginManager {
  plugins: LoadedPlugin[] = []

  constructor(private s: Services) {}

  private userDir() {
    return path.join(this.s.config.dataDir, 'plugins')
  }

  /** Plugins finden und Server-Module laden */
  async load(): Promise<void> {
    const seen = new Set<string>()
    for (const [base, builtin] of [
      [BUILTIN_PLUGIN_DIR, true],
      [this.userDir(), false],
    ] as const) {
      if (!fs.existsSync(base)) continue
      for (const name of fs.readdirSync(base).sort()) {
        const dir = path.join(base, name)
        const mf = path.join(dir, 'manifest.json')
        if (!fs.existsSync(mf)) continue
        let manifest: PluginManifest
        try {
          manifest = JSON.parse(fs.readFileSync(mf, 'utf8'))
        } catch (e) {
          console.error(`[plugins] ${mf}: ungültiges manifest.json – ${(e as Error).message}`)
          continue
        }
        if (!manifest?.id || !ID_RE.test(manifest.id)) {
          console.error(`[plugins] ${mf}: ungültige id`)
          continue
        }
        // Eigenes Plugin mit gleicher id ersetzt das mitgelieferte nicht (Sicherheit + Klarheit)
        if (seen.has(manifest.id)) continue
        seen.add(manifest.id)
        const p: LoadedPlugin = { manifest: { ...manifest, name: manifest.name || manifest.id, version: manifest.version || '0.0.0' }, dir, builtin, module: null, error: null, ctx: null }
        p.ctx = this.context(p)
        if (manifest.server) {
          try {
            p.module = await this.importServer(p)
          } catch (e) {
            p.error = `Server-Modul konnte nicht geladen werden: ${(e as Error).message}`
            console.error(`[plugins] ${manifest.id}: ${p.error}`)
          }
        }
        this.plugins.push(p)
      }
    }
  }

  private async importServer(p: LoadedPlugin): Promise<ServerModule> {
    const built = path.join(p.dir, p.manifest.server!)
    const src = path.join(p.dir, 'src', 'server.ts')
    // In der Entwicklung (Tests) den Quelltext nehmen, sonst das gebaute Modul
    const file = process.env.VITEST && fs.existsSync(src) ? src : fs.existsSync(built) ? built : src
    if (!fs.existsSync(file)) throw new Error(`${p.manifest.server} fehlt (Plugin nicht gebaut?)`)
    const mod = await import(pathToFileURL(file).href)
    return (mod.default ?? mod) as ServerModule
  }

  httpMethods(): string[] {
    return [...new Set(this.plugins.flatMap((p) => (p.manifest.http_methods ?? []).map((m) => m.toUpperCase())))]
  }

  private stateOf(id: string): { enabled?: boolean; settings?: Record<string, any> } {
    const all = (readFileConfig(this.s.config.dataDir) as any).plugins ?? {}
    return all[id] ?? {}
  }

  isEnabled(id: string): boolean {
    const p = this.plugins.find((x) => x.manifest.id === id)
    if (!p || p.error) return false
    const st = this.stateOf(id)
    return st.enabled ?? !!p.manifest.default_enabled
  }

  setEnabled(id: string, enabled: boolean) {
    const p = this.plugins.find((x) => x.manifest.id === id)
    if (!p) throw notFound('Plugin')
    if (enabled && p.error) throw invalid(p.error)
    updateFileConfig(this.s.config.dataDir, (doc) => doc.setIn(['plugins', id, 'enabled'], enabled))
    this.s.events.emit('system.plugins', null, { id, enabled })
  }

  list() {
    return this.plugins.map((p) => {
      const enabled = this.isEnabled(p.manifest.id)
      const v = encodeURIComponent(p.manifest.version)
      return {
        id: p.manifest.id,
        name: p.manifest.name,
        version: p.manifest.version,
        description: p.manifest.description ?? null,
        author: p.manifest.author ?? null,
        builtin: p.builtin,
        enabled,
        error: p.error,
        web: p.manifest.web ? `/plugins/${p.manifest.id}/${p.manifest.web}?v=${v}` : null,
        styles: p.manifest.styles ? `/plugins/${p.manifest.id}/${p.manifest.styles}?v=${v}` : null,
      }
    })
  }

  /** Kontext, den das Plugin bekommt */
  private context(p: LoadedPlugin) {
    const s = this.s
    const id = p.manifest.id
    return {
      id,
      manifest: p.manifest,
      appVersion: s.version,
      isEnabled: () => this.isEnabled(id),
      settings: {
        get: () => this.stateOf(id).settings ?? {},
        set: (values: Record<string, any>) => updateFileConfig(s.config.dataDir, (doc) => doc.setIn(['plugins', id, 'settings'], values)),
      },
      db: s.db,
      vaults: { list: () => s.vaults.list(), get: (vid: string) => s.vaults.get(vid) },
      helpers: {
        vaultFor: (req: FastifyRequest, scope: Scope) => {
          const vid = (req.params as any)?.vault
          if (!vid) throw invalid('Kein Notizbuch in der Adresse (:vault).')
          return vaultFor(req, s, scope)
        },
        noteFor,
        requireScope,
        accessOf,
        isAreaRestricted,
        assertInArea,
        restrictSql,
        restrictionAllows,
        authenticateToken: (req: FastifyRequest, token: string) => {
          const principal = s.auth.tokenPrincipal(token)
          if (!principal) return false
          req.principal = principal
          return true
        },
        json,
        stripLink,
        listTasks,
        setTask,
        appendTask,
        error: (code: any, message: string, details?: Record<string, unknown>) => new ApiError(code, message, details),
      },
      allowArea: (method: string, url: string, access: 'read' | 'write') => allowAreaRoute(method, url, access),
      log: {
        info: (m: string) => console.log(`[plugin ${id}] ${m}`),
        warn: (m: string) => console.warn(`[plugin ${id}] ${m}`),
        error: (m: string | Error) => console.error(`[plugin ${id}]`, m),
      },
    }
  }

  /** Endpunkte unter /api/v1 (Anmeldung und Freigaben wie im Kern) */
  async registerApi(api: FastifyInstance) {
    for (const p of this.plugins) {
      if (!p.module?.api) continue
      const pid = p.manifest.id
      await api.register(async (scope) => {
        scope.addHook('onRequest', async () => {
          if (!this.isEnabled(pid)) throw new ApiError('not_found', 'Unbekannter API-Pfad.')
        })
        await p.module!.api!(scope, p.ctx)
      })
    }
  }

  /** Endpunkte ab / (eigene Anmeldung) */
  async registerRoot(app: FastifyInstance) {
    for (const p of this.plugins) {
      if (!p.module?.root) continue
      const pid = p.manifest.id
      await app.register(async (scope) => {
        scope.addHook('onRequest', async (_req, reply) => {
          if (!this.isEnabled(pid)) return reply.code(404).type('text/plain; charset=utf-8').send('Nicht gefunden')
        })
        await p.module!.root!(scope, p.ctx)
      })
    }
  }

  /** Datei der Oberfläche eines Plugins (nur aus dem Ordner des web-/styles-Moduls) */
  webFile(id: string, rel: string): { file: string; type: string } | null {
    const p = this.plugins.find((x) => x.manifest.id === id)
    if (!p) return null
    const allowedDirs = [p.manifest.web, p.manifest.styles].filter(Boolean).map((f) => path.dirname(path.join(p.dir, f!)))
    const file = path.resolve(p.dir, rel)
    if (!allowedDirs.some((d) => file.startsWith(d + path.sep))) return null
    const type = MIME[path.extname(file).toLowerCase()]
    if (!type || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null
    return { file, type }
  }

  /** Verwaltungs-Endpunkte unter /api/v1 */
  registerManagement(api: FastifyInstance) {
    api.get('/plugins', { schema: { tags: ['System'], summary: 'Installierte Plugins (eingeschaltet, Oberflächen-Module)' } }, async () => ({ items: this.list() }))
    api.put(
      '/plugins/:id',
      { schema: { tags: ['System'], summary: 'Plugin ein-/ausschalten {enabled} (admin)', body: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' } } } } },
      async (req) => {
        requireScope(req, 'admin')
        this.setEnabled((req.params as any).id, (req.body as any).enabled)
        return { items: this.list() }
      },
    )
  }

  /** Oberflächen-Dateien ausliefern: /plugins/<id>/<pfad> */
  registerAssets(app: FastifyInstance) {
    app.get('/plugins/:id/*', async (req, reply) => {
      const { id } = req.params as any
      const rel = decodeURIComponent((req.params as any)['*'] ?? '')
      const f = this.webFile(id, rel)
      if (!f) return reply.code(404).type('text/plain; charset=utf-8').send('Nicht gefunden')
      return reply.type(f.type).header('Cache-Control', 'public, max-age=300').send(fs.createReadStream(f.file))
    })
  }
}
