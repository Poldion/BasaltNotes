import type { FastifyInstance } from 'fastify'
import { ACCESS_LEVELS, grantRestricted, isServerAdmin, ROLES, ROLE_LABELS, ROLE_SCOPES, SCOPES, requireScope, setSessionCookie, SESSION_COOKIE, type Scope } from '../auth.js'
import { loadConfig, readFileConfig, thinkMode, updateFileConfig } from '../config.js'
import { THINK_MODES } from '../curator/llm.js'
import { saveFeatures } from '../features.js'
import { EVENT_TYPES } from '../events.js'
import { ApiError, invalid } from '../lib/errors.js'
import { Register, Services, T } from './common.js'

const grantSchema = {
  type: 'object',
  properties: {
    vault: { type: 'string' },
    access: { type: 'string', enum: Object.keys(ACCESS_LEVELS) },
    campaign: { type: ['string', 'null'] },
    shared: { type: 'boolean' },
    folders: { type: 'array', items: { type: 'string' } },
    types: { type: 'array', items: { type: 'string' } },
  },
  required: ['vault', 'access'],
}

export const registerSystem: Register = (app: FastifyInstance, s: Services) => {
  app.get('/health', { schema: { tags: T.system, summary: 'Status: Index, LLM, aktives Modell, Kontextgröße, Warteschlange' } }, async (req) => {
    const ai = !!(s.config.features?.curator || s.config.features?.chat)
    // Ohne KI-Funktionen wird das LLM gar nicht erst angefragt
    const llm = ai
      ? { enabled: true, ...(await s.llm.info((req.query as any)?.refresh === '1').catch((e) => ({ reachable: false, error: (e as Error).message }))) }
      : { enabled: false, reachable: false }
    return {
      status: 'ok',
      version: s.version,
      time: new Date().toISOString(),
      index: { vaults: s.vaults.list().map((v) => ({ id: v.id, name: v.config.name, notes: v.count() })) },
      llm,
      queue: s.jobs.stats(),
    }
  })

  // ------------------------------------------------------------ LLM-Einstellungen

  const llmSettings = () => {
    const file = readFileConfig(s.config.dataDir)
    const env = process.env
    return {
      url: s.config.llm.url,
      model: s.config.llm.model ?? null,
      num_ctx: s.config.llm.num_ctx ?? null,
      think_chat: s.config.llm.think_chat ?? 'off',
      think_curator: s.config.llm.think_curator ?? 'off',
      /** In der Oberfläche gesetzte Werte (Vorrang vor Umgebungsvariablen) */
      override: file.llm_override ?? null,
      /** Werte aus der Compose-Datei bzw. den Umgebungsvariablen */
      env: {
        url: env.LLM_URL ?? null,
        model: env.LLM_MODEL ?? null,
        num_ctx: env.LLM_NUM_CTX ? Number(env.LLM_NUM_CTX) : null,
        think_chat: env.LLM_THINK_CHAT ?? null,
        think_curator: env.LLM_THINK_CURATOR ?? null,
      },
    }
  }

  const listModels = async (url: string) => {
    const base = new URL(url)
    const get = async (path: string) => {
      const res = await fetch(new URL(path, base), { signal: AbortSignal.timeout(5000) })
      if (!res.ok) throw new Error(`HTTP ${res.status} von ${path}`)
      return res.json() as Promise<any>
    }
    const tags = await get('/api/tags')
    let loaded: string[] = []
    try {
      loaded = ((await get('/api/ps')).models ?? []).map((m: any) => m.name ?? m.model)
    } catch {
      // /api/ps gibt es nicht überall (z. B. hinter manchen Proxys)
    }
    const models = (Array.isArray(tags?.models) ? tags.models : []).map((m: any) => ({
      name: String(m.name ?? m.model),
      size: Number(m.size) || null,
      parameter_size: m.details?.parameter_size ?? null,
      quantization: m.details?.quantization_level ?? null,
      loaded: loaded.includes(m.name ?? m.model),
    }))
    return { url: base.toString().replace(/\/$/, ''), models, loaded }
  }

  const checkUrl = (url: unknown): string => {
    const u = String(url ?? '').trim().replace(/\/+$/, '')
    if (!/^https?:\/\/[^\s/]+/i.test(u)) throw invalid('Adresse muss mit http:// oder https:// beginnen, z. B. http://localhost:11434.')
    try {
      new URL(u)
    } catch {
      throw invalid('Ungültige Adresse.')
    }
    return u
  }

  app.get('/system/llm', { schema: { tags: T.system, summary: 'LLM-Einstellungen: Adresse, Modell, Kontext (admin)' } }, async (req) => {
    requireScope(req, 'admin')
    return llmSettings()
  })

  app.get('/system/llm/models', { schema: { tags: T.system, summary: 'Modelle eines LLM-Servers auflisten (?url=…, sonst der eingestellte) (admin)' } }, async (req) => {
    requireScope(req, 'admin')
    const q = req.query as any
    const url = q.url ? checkUrl(q.url) : s.config.llm.url
    try {
      return await listModels(url)
    } catch (e) {
      throw new ApiError('llm_unavailable', `Server ${url} nicht erreichbar: ${(e as Error).message}`, { reason: 'unreachable' })
    }
  })

  app.put(
    '/system/llm',
    {
      schema: {
        tags: T.system,
        summary: 'LLM-Adresse/Modell ändern – gilt sofort, wird in config.yaml gespeichert und hat Vorrang vor LLM_URL/LLM_MODEL (admin). {"reset": true} setzt zurück.',
        body: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            model: { type: ['string', 'null'] },
            num_ctx: { type: ['integer', 'null'], minimum: 0, maximum: 1048576 },
            think_chat: { type: 'string', enum: THINK_MODES },
            think_curator: { type: 'string', enum: THINK_MODES },
            reset: { type: 'boolean' },
          },
        },
      },
    },
    async (req) => {
      requireScope(req, 'admin')
      const b = req.body as any
      if (b.reset) {
        updateFileConfig(s.config.dataDir, (doc) => doc.delete('llm_override'))
      } else {
        const cur = readFileConfig(s.config.dataDir).llm_override ?? {}
        const next = { ...cur }
        if (b.url !== undefined) next.url = checkUrl(b.url)
        if (b.model !== undefined) next.model = String(b.model ?? '').trim()
        if (b.num_ctx !== undefined) next.num_ctx = Number(b.num_ctx) || 0
        if (b.think_chat !== undefined) next.think_chat = thinkMode(b.think_chat)
        if (b.think_curator !== undefined) next.think_curator = thinkMode(b.think_curator)
        updateFileConfig(s.config.dataDir, (doc) => doc.set('llm_override', next))
      }
      // Sofort übernehmen: der LLM-Client liest dieselbe Konfiguration
      const fresh = loadConfig({ dataDir: s.config.dataDir })
      s.config.llm.url = fresh.llm.url
      s.config.llm.model = fresh.llm.model
      s.config.llm.num_ctx = fresh.llm.num_ctx
      s.config.llm.think_chat = fresh.llm.think_chat
      s.config.llm.think_curator = fresh.llm.think_curator
      s.llm.reset?.()
      const info = await s.llm.info(true).catch((e) => ({ reachable: false, error: (e as Error).message }))
      return { ...llmSettings(), info }
    },
  )

  // ------------------------------------------------------------ Anmeldung

  app.post(
    '/auth/login',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: T.system,
        summary: 'Anmelden (setzt Session-Cookie, liefert CSRF-Token)',
        body: { type: 'object', properties: { username: { type: 'string' }, password: { type: 'string' } }, required: ['username', 'password'] },
      },
    },
    async (req, reply) => {
      const b = req.body as any
      const sess = await s.auth.login(String(b.username ?? ''), String(b.password ?? ''))
      setSessionCookie(reply, sess.id, sess.expires, req.protocol === 'https')
      return { user: sess.user, csrf: sess.csrf, expires: sess.expires }
    },
  )

  app.post('/auth/logout', { schema: { tags: T.system, summary: 'Abmelden' } }, async (req, reply) => {
    const id = req.cookies?.[SESSION_COOKIE]
    if (id) s.auth.logout(id)
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })

  app.get('/auth/me', { schema: { tags: T.system, summary: 'Aktuelle Anmeldung (Benutzer, Rolle, Rechte, CSRF-Token)' } }, async (req) => {
    const p = req.principal!
    return {
      kind: p.kind,
      name: p.name,
      user_id: p.userId ?? null,
      display_name: p.displayName ?? p.name,
      role: p.role ?? null,
      vaults: p.vaults,
      scopes: p.scopes,
      access: p.access.map((x) => ({ ...x, area: grantRestricted(p.grants?.find((g) => g.vault === x.vault)) })),
      server_admin: isServerAdmin(p),
      visibility: p.visibility ?? null,
      campaign: p.campaign ?? null,
      csrf: p.csrf ?? null,
      embed_origins: s.config.embedOrigins,
      roles: ROLES.map((r) => ({ name: r, label: ROLE_LABELS[r] })),
      features: s.config.features,
    }
  })

  // ------------------------------------------------------------ Funktionen (KI an/aus, Einrichtung)

  app.get('/system/features', { schema: { tags: T.system, summary: 'Eingeschaltete Funktionen {curator, chat, setup_done}' } }, async () => s.config.features)

  app.put(
    '/system/features',
    {
      schema: {
        tags: T.system,
        summary: 'Funktionen schalten {curator?, chat?, setup_done?} – gilt sofort (admin)',
        body: { type: 'object', properties: { curator: { type: 'boolean' }, chat: { type: 'boolean' }, setup_done: { type: 'boolean' } } },
      },
    },
    async (req) => {
      requireScope(req, 'admin')
      const b = req.body as any
      const f = s.config.features!
      for (const k of ['curator', 'chat', 'setup_done'] as const) if (typeof b[k] === 'boolean') f[k] = b[k]
      saveFeatures(s.config)
      if (f.curator || f.chat) s.llm.reset?.()
      s.events.emit('system.features', null, { ...f })
      return f
    },
  )

  app.post('/auth/password', { schema: { tags: T.system, summary: 'Eigenes Passwort ändern {current, new}' } }, async (req) => {
    const p = req.principal!
    if (!p.userId) throw new ApiError('forbidden', 'Nur für angemeldete Benutzer.')
    const b = (req.body ?? {}) as any
    await s.auth.changeOwnPassword(p.userId, String(b.current ?? ''), String(b.new ?? ''), req.cookies?.[SESSION_COOKIE])
    return { ok: true }
  })

  // ------------------------------------------------------------ Benutzer

  const userBody = {
    type: 'object',
    properties: {
      username: { type: 'string' },
      display_name: { type: ['string', 'null'] },
      password: { type: 'string' },
      role: { type: 'string', enum: [...ROLES] },
      vaults: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string', enum: ['*'] }] },
      grants: { type: 'array', items: grantSchema },
      campaign: { type: ['string', 'null'] },
      disabled: { type: 'boolean' },
    },
  }

  app.get('/users', { schema: { tags: T.system, summary: 'Benutzer (nur admin)' } }, async (req) => {
    requireScope(req, 'admin')
    return { items: s.auth.listUsers(), roles: ROLES.map((r) => ({ name: r, label: ROLE_LABELS[r], scopes: ROLE_SCOPES[r] })) }
  })

  app.post('/users', { schema: { tags: T.system, summary: 'Benutzer anlegen {username, password, role, grants? (Rolle member), vaults?, campaign?, display_name?}', body: { ...userBody, required: ['username', 'password', 'role'] } } }, async (req, reply) => {
    requireScope(req, 'admin')
    for (const g of (req.body as any).grants ?? []) if (g?.vault !== '*') s.vaults.get(String(g?.vault ?? ''))
    reply.code(201)
    return s.auth.createUser(req.body as any)
  })

  app.patch('/users/:id', { schema: { tags: T.system, summary: 'Benutzer ändern (Rolle, Rechte je Notizbuch, Vaults, sperren, Passwort zurücksetzen)', body: userBody } }, async (req) => {
    requireScope(req, 'admin')
    const id = (req.params as any).id
    const b = { ...(req.body as any) }
    for (const g of b.grants ?? []) if (g?.vault !== '*') s.vaults.get(String(g?.vault ?? ''))
    if (id === req.principal!.userId && (b.disabled === true || (b.role && b.role !== 'admin'))) throw new ApiError('conflict', 'Das eigene Konto kann nicht gesperrt oder herabgestuft werden.')
    return s.auth.updateUser(id, b)
  })

  app.delete('/users/:id', { schema: { tags: T.system, summary: 'Benutzer löschen' } }, async (req) => {
    requireScope(req, 'admin')
    const id = (req.params as any).id
    if (id === req.principal!.userId) throw new ApiError('conflict', 'Das eigene Konto kann nicht gelöscht werden.')
    s.auth.deleteUser(id)
    return { deleted: true }
  })

  // ------------------------------------------------------------ Tokens

  app.get('/tokens', { schema: { tags: T.system, summary: 'API-Tokens (nur admin)' } }, async (req) => {
    requireScope(req, 'admin')
    return { items: s.auth.listTokens() }
  })

  app.post(
    '/tokens',
    {
      schema: {
        tags: T.system,
        summary:
          'Token anlegen mit Freigaben je Notizbuch {name, grants: [{vault (oder *), access: read|inbox|read_inbox|curate|write|write_curate|admin, campaign?, shared?, folders?, types?}], scopes?: [create_vault]}; weiterhin möglich: klassisch {name, vaults, scopes, campaign?}. Das Token wird nur einmal angezeigt',
        body: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            vaults: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string', enum: ['*'] }] },
            scopes: { type: 'array', items: { type: 'string', enum: [...SCOPES] } },
            expires: { type: ['string', 'null'] },
            visibility: { type: ['string', 'null'], enum: ['players', null] },
            campaign: { type: ['string', 'null'] },
            kind: { type: 'string', enum: ['api', 'share'] },
            grants: { type: ['array', 'null'], items: grantSchema },
          },
          required: ['name'],
        },
      },
    },
    async (req, reply) => {
      requireScope(req, 'admin')
      const b = req.body as any
      if (Array.isArray(b.grants)) for (const g of b.grants) if (g?.vault !== '*') s.vaults.get(String(g?.vault ?? ''))
      reply.code(201)
      return s.auth.createToken({ name: b.name, vaults: b.vaults ?? '*', scopes: b.scopes, grants: b.grants ?? undefined, expires: b.expires, visibility: b.visibility, campaign: b.campaign, kind: b.kind })
    },
  )

  app.patch(
    '/tokens/:id',
    {
      schema: {
        tags: T.system,
        summary: 'Token ändern {name?, grants?, create_vault?, expires?} – der Token-Wert bleibt gleich (nur admin)',
        body: { type: 'object', properties: { name: { type: 'string' }, grants: { type: 'array', items: grantSchema }, create_vault: { type: 'boolean' }, expires: { type: ['string', 'null'] } } },
      },
    },
    async (req) => {
      requireScope(req, 'admin')
      const b = req.body as any
      for (const g of b.grants ?? []) if (g?.vault !== '*') s.vaults.get(String(g?.vault ?? ''))
      return s.auth.updateToken((req.params as any).id, b)
    },
  )

  app.post('/tokens/embed', { schema: { tags: T.system, summary: 'Kurzlebiges Embed-Token {vault, scope: read|write, ttl (Sekunden), visibility?, campaign?}' } }, async (req, reply) => {
    const b = (req.body ?? {}) as any
    const vault = s.vaults.get(String(b.vault ?? '')).id
    const scope: Scope = b.scope === 'write' ? 'write' : 'read'
    requireScope(req, scope, vault)
    const ttl = Math.min(Math.max(Number(b.ttl) || 3600, 60), 7 * 86400)
    const p = req.principal!
    const visibility = p.visibility === 'players' ? 'players' : b.visibility === 'players' ? 'players' : null
    const t = s.auth.createToken({
      name: `embed:${p.name}`,
      vaults: [vault],
      scopes: [scope],
      expires: new Date(Date.now() + ttl * 1000).toISOString(),
      visibility,
      campaign: p.campaign ?? b.campaign ?? null,
      kind: 'embed',
    })
    reply.code(201)
    return { token: t.token, expires: t.expires, vault, scope, visibility }
  })

  app.delete('/tokens/:id', { schema: { tags: T.system, summary: 'Token widerrufen' } }, async (req) => {
    requireScope(req, 'admin')
    s.auth.deleteToken((req.params as any).id)
    return { deleted: true }
  })

  // ------------------------------------------------------------ Webhooks

  app.get('/webhooks', { schema: { tags: T.events, summary: 'Webhooks mit letzten Zustellungen' } }, async (req) => {
    requireScope(req, 'admin')
    return { items: s.webhooks.list(), events: EVENT_TYPES }
  })

  app.post('/webhooks', { schema: { tags: T.events, summary: 'Webhook anlegen {url, events, vaults, secret?} – Signatur X-Basalt-Signature: sha256=HMAC(secret, body)' } }, async (req, reply) => {
    requireScope(req, 'admin')
    const b = (req.body ?? {}) as any
    if (!b.url) throw invalid('url fehlt.')
    reply.code(201)
    return s.webhooks.create(b)
  })

  app.delete('/webhooks/:id', { schema: { tags: T.events, summary: 'Webhook löschen' } }, async (req) => {
    requireScope(req, 'admin')
    s.webhooks.delete((req.params as any).id)
    return { deleted: true }
  })

  // ------------------------------------------------------------ Server-Sent Events

  app.get('/events', { schema: { tags: T.events, summary: 'Server-Sent Events (?vault=dnd). Mit Bearer-Header oder ?token=' } }, async (req, reply) => {
    const p = req.principal!
    const filter = (req.query as any)?.vault ? String((req.query as any).vault).split(',') : null
    if (filter) for (const v of filter) requireScope(req, 'read', s.vaults.get(v).id)
    else requireScope(req, 'read')
    reply.hijack()
    const res = reply.raw
    const origin = req.headers.origin
    const headers: Record<string, string> = {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    }
    if (origin && s.config.corsOrigins.includes(origin)) {
      headers['access-control-allow-origin'] = origin
      headers['access-control-allow-credentials'] = 'true'
    }
    res.writeHead(200, headers)
    res.write(`retry: 3000\n\n`)
    res.write(`event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`)
    let n = 0
    const off = s.events.on((e) => {
      if (e.vault && filter && !filter.includes(e.vault)) return
      if (e.vault && p.vaults !== '*' && !p.vaults.includes(e.vault)) return
      if (!e.vault && p.vaults !== '*') return
      res.write(`id: ${Date.now()}-${n++}\nevent: ${e.event}\ndata: ${JSON.stringify(e)}\n\n`)
    })
    const ping = setInterval(() => res.write(`: ping\n\n`), 25_000)
    req.raw.on('close', () => {
      clearInterval(ping)
      off()
    })
  })
}
