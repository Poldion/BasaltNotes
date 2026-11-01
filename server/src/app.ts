import fs from 'node:fs'
import { requestLang, translateMessage } from './i18n.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import swagger from '@fastify/swagger'
import { Auth } from './auth.js'
import { loadConfig, type AppConfig } from './config.js'
import { Db, nowIso } from './db.js'
import { EventBus } from './events.js'
import { JobQueue } from './jobs.js'
import { ApiError } from './lib/errors.js'
import { Webhooks } from './webhooks.js'
import { VaultManager } from './notes/vaults.js'
import { Search } from './notes/search.js'
import { OllamaClient, type LlmClient } from './curator/llm.js'
import { Curator } from './curator/curator.js'
import { Inbox } from './curator/inbox.js'
import { checkAreaRoute, type Services } from './routes/common.js'
import { checkFeatureRoute, initFeatures } from './features.js'
import { registerNotes } from './routes/notes.js'
import { registerVaults } from './routes/vaults.js'
import { registerSearch } from './routes/search.js'
import { registerCurator } from './routes/curator.js'
import { registerSystem } from './routes/system.js'
import { registerChat } from './routes/chat.js'
import { PluginManager } from './plugins/manager.js'
import { ChatService } from './chat/chat.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Version aus der package.json im Hauptordner (einzige maßgebliche Stelle), sonst aus server/package.json */
function readVersion(): string {
  for (const p of [path.join(here, '..', '..', 'package.json'), path.join(here, '..', 'package.json')]) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8')).version ?? '0.0.0'
    } catch {
      // weiter
    }
  }
  return '0.0.0'
}

declare module 'fastify' {
  interface FastifyRequest {
    idempotency?: { key: string; scope: string; replayed: boolean }
  }
}

const PUBLIC_API = new Set(['/api/v1/health', '/api/v1/auth/login', '/api/v1/openapi.json'])

export interface BuildOptions {
  config?: Partial<AppConfig>
  llm?: LlmClient
  logger?: boolean
  webDir?: string | null
}

export async function buildApp(opts: BuildOptions = {}): Promise<{ app: FastifyInstance; services: Services; generatedPassword: string | null }> {
  const config = loadConfig(opts.config)
  const db = new Db(path.join(config.dataDir, 'index.sqlite'))
  const events = new EventBus()
  const jobs = new JobQueue(db)
  const vaults = new VaultManager(path.join(config.dataDir, 'vaults'), db, events, { commitDelayMs: config.commitDelayMs, watch: config.watch })
  const search = new Search(db)
  const auth = new Auth(db, config)
  const generatedPassword = await auth.init()
  const webhooks = new Webhooks(db, events, jobs)
  const llm = opts.llm ?? new OllamaClient(config.llm)
  const curator = new Curator(db, vaults, llm, events)
  const inbox = new Inbox(db, vaults, curator, jobs, events, () => !!config.features?.curator)
  const chat = new ChatService(db, vaults, llm, config)
  const services: Services = { config, db, events, vaults, search, auth, jobs, webhooks, llm, curator, inbox, chat, version: readVersion() }
  // Plugins (mitgeliefert und unter /data/plugins) – Server-Module werden jetzt geladen
  const plugins = new PluginManager(services)
  await plugins.load()
  services.plugins = plugins
  // Erst nach den Plugins: Vaults brauchen die Vorlagen, die Plugins mitbringen
  await vaults.init()
  initFeatures(config, db)

  const app = Fastify({
    logger: opts.logger === false ? false : { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: config.trustProxy,
    bodyLimit: 20 * 1024 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, allErrors: false, strict: false } },
  })

  // Zusätzliche HTTP-Methoden, die Plugins brauchen (z. B. PROPFIND/REPORT für CalDAV)
  for (const m of plugins.httpMethods()) app.addHttpMethod(m, { hasBody: true })

  await app.register(cookie)
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'if-match', 'idempotency-key', 'x-csrf-token'],
    exposedHeaders: ['etag'],
  })
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 1 } })
  await app.register(rateLimit, {
    global: true,
    max: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 1200),
    timeWindow: '1 minute',
    // Nur die API begrenzen – Seiten und Skripte der Oberfläche nie (sonst zeigt der Browser JSON statt der App)
    allowList: (req) => !req.url.startsWith('/api/'),
    errorResponseBuilder: (_req, ctx) => {
      const e = new ApiError('rate_limited', `Zu viele Anfragen. Bitte in ${Math.ceil(ctx.ttl / 1000)} s erneut versuchen.`)
      return Object.assign(e, { statusCode: 429 })
    },
  })
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: { title: 'BasaltNotes API', version: services.version, description: 'REST-API von BasaltNotes. Authentifizierung per Bearer-Token oder Session-Cookie (+ X-CSRF-Token).' },
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
      security: [{ bearer: [] }],
    },
  })

  // ------------------------------------------------------------ Fehlerformat
  app.setErrorHandler((err: any, req, reply) => {
    // Meldung in der Sprache der Anfrage (Code und Details bleiben unverändert)
    const lang = requestLang(req)
    const send = (status: number, e: ApiError) => {
      const json = e.toJSON()
      return reply.code(status).send({ error: { ...json.error, message: translateMessage(json.error.message, lang) } })
    }
    if (err instanceof ApiError) return send(err.status, err)
    if (err?.cancelled) return send(409, new ApiError('conflict', 'Abgebrochen.'))
    if (err.validation) return send(400, new ApiError('validation_error', err.message, { validation: err.validation }))
    if (err.statusCode === 429) return send(429, new ApiError('rate_limited', err.message))
    if (err.statusCode && err.statusCode < 500) {
      const code = err.statusCode === 404 ? 'not_found' : err.statusCode === 401 ? 'unauthorized' : err.statusCode === 403 ? 'forbidden' : 'validation_error'
      return send(err.statusCode, new ApiError(code as any, err.message))
    }
    req.log.error(err)
    return send(500, new ApiError('internal_error', 'Interner Fehler.', { message: err.message }))
  })

  // ------------------------------------------------------------ Sicherheits-Header
  const frameAncestors = ["'self'", ...config.embedOrigins].join(' ')
  app.addHook('onSend', async (req, reply, payload) => {
    const ct = String(reply.getHeader('content-type') ?? '')
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'same-origin')
    if (ct.startsWith('text/html') && !req.url.startsWith('/api/')) {
      const embed = req.url.startsWith('/embed/')
      reply.header(
        'Content-Security-Policy',
        `default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors ${embed ? frameAncestors : "'self'"}`,
      )
    }
    return payload
  })

  // ------------------------------------------------------------ API
  await app.register(
    async (api) => {
      // Anmeldung + CSRF
      api.addHook('onRequest', async (req) => {
        const url = req.url.split('?')[0]
        if (req.method === 'OPTIONS') return
        let principal = null
        try {
          principal = services.auth.authenticate(req)
        } catch (e) {
          if (PUBLIC_API.has(url)) return
          throw e
        }
        if (principal) req.principal = principal
        if (PUBLIC_API.has(url)) return
        if (!req.principal) throw new ApiError('unauthorized', 'Anmeldung erforderlich.')
        if (req.principal.kind === 'session' && !['GET', 'HEAD'].includes(req.method) && url !== '/api/v1/auth/logout') {
          if (req.headers['x-csrf-token'] !== req.principal.csrf) throw new ApiError('forbidden', 'CSRF-Token fehlt oder ist ungültig.')
        }
      })

      // Zugänge mit Bereichs-Einschränkung: nur freigegebene Funktionen
      api.addHook('preHandler', async (req) => checkAreaRoute(req, '/api/v1'))
      // Ausgeschaltete KI-Funktionen
      api.addHook('preHandler', async (req) => checkFeatureRoute(req, config, '/api/v1'))

      // Idempotenz für POST
      api.addHook('preHandler', async (req, reply) => {
        const key = req.headers['idempotency-key']
        if (req.method !== 'POST' || typeof key !== 'string' || !key) return
        const scope = `${req.principal?.tokenId ?? req.principal?.name ?? 'anon'}:${req.method}:${req.url.split('?')[0]}`
        const hit = db.get<{ status: number; body: string; headers: string }>('SELECT status, body, headers FROM idempotency WHERE key = ? AND scope = ?', key, scope)
        if (hit) {
          req.idempotency = { key, scope, replayed: true }
          const h = JSON.parse(hit.headers ?? '{}')
          reply.code(hit.status).header('content-type', h['content-type'] ?? 'application/json; charset=utf-8').header('Idempotent-Replayed', 'true')
          return reply.send(hit.body)
        }
        req.idempotency = { key, scope, replayed: false }
      })
      api.addHook('onSend', async (req, reply, payload) => {
        const idem = req.idempotency
        if (idem && !idem.replayed && reply.statusCode < 500 && typeof payload === 'string') {
          db.run(
            'INSERT OR IGNORE INTO idempotency (key, scope, status, body, headers, created) VALUES (?,?,?,?,?,?)',
            idem.key,
            idem.scope,
            reply.statusCode,
            payload,
            JSON.stringify({ 'content-type': reply.getHeader('content-type') }),
            nowIso(),
          )
        }
        return payload
      })

      registerSystem(api, services)
      registerVaults(api, services)
      registerNotes(api, services)
      registerSearch(api, services)
      registerCurator(api, services)
      registerChat(api, services)
      plugins.registerManagement(api)
      await plugins.registerApi(api)
      api.get('/openapi.json', { schema: { hide: true } as any }, async () => app.swagger())
      api.all('/*', async () => {
        throw new ApiError('not_found', 'Unbekannter API-Pfad.')
      })
    },
    // Request-Logs (info) nur mit LOG_REQUESTS=true – sonst nur Warnungen/Fehler
    { prefix: '/api/v1', logLevel: process.env.LOG_REQUESTS === 'true' ? 'info' : 'warn' },
  )

  // ------------------------------------------------------------ Plugins: eigene Endpunkte ab / und Oberflächen-Dateien
  plugins.registerAssets(app)
  await plugins.registerRoot(app)

  // ------------------------------------------------------------ Web-Oberfläche
  const webDir = opts.webDir === null ? null : (opts.webDir ?? process.env.WEB_DIR ?? path.resolve(here, '..', '..', 'web', 'dist'))
  if (webDir && fs.existsSync(path.join(webDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDir, wildcard: false, index: false, cacheControl: false })
    const indexHtml = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8')
    const sendIndex = (_req: any, reply: any) => reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(indexHtml)
    app.get('/', sendIndex)
    app.get('/*', (req, reply) => {
      const rel = decodeURIComponent((req.params as any)['*'] ?? '')
      const file = path.join(webDir, rel)
      if (rel && !rel.includes('..') && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const immutable = rel.startsWith('assets/')
        return reply.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache').sendFile(rel)
      }
      return sendIndex(req, reply)
    })
  } else {
    app.get('/', async () => ({ name: 'BasaltNotes', api: '/api/v1', hint: 'Web-Oberfläche nicht gebaut (npm run build).' }))
  }

  // Aufräumen
  const cleanup = setInterval(() => {
    db.run("DELETE FROM idempotency WHERE julianday(created) < julianday('now', '-7 days')")
    db.run('DELETE FROM sessions WHERE expires < ?', new Date().toISOString())
    db.run("DELETE FROM webhook_deliveries WHERE julianday(created) < julianday('now', '-30 days')")
  }, 3600_000)

  app.addHook('onClose', async () => {
    clearInterval(cleanup)
    await jobs.stop()
    await vaults.close()
    db.close()
  })

  jobs.start()
  return { app, services, generatedPassword }
}
