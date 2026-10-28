import crypto from 'node:crypto'
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { ulid } from 'ulid'
import { Db, json, nowIso } from './db.js'
import { ApiError, invalid, notFound } from './lib/errors.js'
import { randomToken, sha256 } from './lib/util.js'
import { AppConfig, updateFileConfig } from './config.js'

export const SCOPES = ['read', 'write', 'inbox', 'curate', 'admin'] as const
export type Scope = (typeof SCOPES)[number]

export const ROLES = ['admin', 'editor', 'viewer', 'player'] as const
export type Role = (typeof ROLES)[number]

/** Rechte je Rolle. „player“ sieht nur Inhalte mit visibility: players. */
export const ROLE_SCOPES: Record<Role, Scope[]> = {
  admin: [...SCOPES],
  editor: ['read', 'write', 'inbox', 'curate'],
  viewer: ['read'],
  player: ['read'],
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administration',
  editor: 'Bearbeiten',
  viewer: 'Lesen',
  player: 'Spieler (nur Spieler-Inhalte)',
}

/**
 * Freigabe eines Notizbuchs (Vault) für einen API-Zugang: Lesen oder Schreiben,
 * optional beschränkt auf einen Bereich (Kampagne, Ordner, Typen).
 */
export interface Grant {
  vault: string
  access: 'read' | 'write'
  /** Nur Einträge dieser Kampagne */
  campaign?: string | null
  /** Bei Kampagne: auch Einträge ohne Kampagne (z. B. allgemeine Welt-/Regelnotizen). Standard: ja */
  shared?: boolean
  /** Nur Einträge in diesen Ordnern (inkl. Unterordner) */
  folders?: string[]
  /** Nur Einträge dieser Typen */
  types?: string[]
}

/** Hat die Freigabe eine Bereichs-Einschränkung? */
export function grantRestricted(g: Grant | undefined | null): boolean {
  return !!g && (!!g.campaign || !!g.folders?.length || !!g.types?.length)
}

/** Freigaben prüfen und vereinheitlichen */
export function normalizeGrants(input: unknown): Grant[] {
  if (!Array.isArray(input)) throw invalid('grants muss eine Liste sein.')
  const out: Grant[] = []
  for (const raw of input) {
    const g = raw as any
    const vault = String(g?.vault ?? '').trim()
    if (!vault) throw invalid('Jede Freigabe braucht ein Notizbuch (vault).')
    if (g.access !== 'read' && g.access !== 'write') throw invalid('access muss "read" oder "write" sein.')
    if (out.some((x) => x.vault === vault)) throw invalid(`Notizbuch „${vault}“ ist doppelt freigegeben.`)
    const list = (v: unknown) =>
      (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [])
        .map((x) => String(x).trim().replace(/^\/+|\/+$/g, ''))
        .filter(Boolean)
    const folders = list(g.folders)
    if (folders.some((f) => f.split('/').includes('..'))) throw invalid('Ungültiger Ordner.')
    const types = list(g.types)
    const campaign = g.campaign ? String(g.campaign).trim() : null
    out.push({ vault, access: g.access, ...(campaign ? { campaign, shared: g.shared !== false } : {}), ...(folders.length ? { folders } : {}), ...(types.length ? { types } : {}) })
  }
  if (!out.length) throw invalid('Mindestens ein Notizbuch freigeben.')
  return out
}

export interface Principal {
  kind: 'session' | 'token'
  name: string
  userId?: string
  role?: Role
  displayName?: string
  /** '*' = alle Vaults */
  vaults: string[] | '*'
  scopes: Scope[]
  visibility?: 'players' | null
  campaign?: string | null
  /** Freigaben je Notizbuch (neue API-Zugänge) – haben Vorrang vor vaults/scopes/campaign */
  grants?: Grant[] | null
  tokenId?: string
  csrf?: string
}

export interface UserRow {
  id: string
  username: string
  display_name: string | null
  password_hash: string | null
  role: Role
  vaults: string
  campaign: string | null
  disabled: number
  created: string
  updated: string
  last_login: string | null
}

export const SESSION_COOKIE = 'basalt_session'
const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._@-]{1,62}$/

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal
  }
}

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    role: u.role,
    vaults: json<string[] | '*'>(u.vaults, '*'),
    campaign: u.campaign,
    disabled: !!u.disabled,
    has_password: !!u.password_hash,
    created: u.created,
    updated: u.updated,
    last_login: u.last_login,
  }
}

export interface UserInput {
  username?: string
  display_name?: string | null
  password?: string
  role?: Role
  vaults?: string[] | '*'
  campaign?: string | null
  disabled?: boolean
}

export class Auth {
  private secret = ''

  constructor(
    private db: Db,
    private config: AppConfig,
  ) {}

  // ------------------------------------------------------------ Start

  /**
   * Beim ersten Start einen Admin anlegen: Passwort aus ADMIN_PASSWORD, aus einer älteren
   * config.yaml oder zufällig (wird dann einmal geloggt).
   */
  async init(): Promise<string | null> {
    this.secret = this.config.secret ?? ''
    if (!this.secret) {
      this.secret = randomToken(32)
      updateFileConfig(this.config.dataDir, (doc) => doc.set('secret', this.secret))
    }
    const envPw = process.env.ADMIN_PASSWORD
    const count = this.db.get<{ n: number }>('SELECT COUNT(*) n FROM users')?.n ?? 0
    if (count === 0) {
      const username = this.config.admin.username
      let generated: string | null = null
      let hash = this.config.admin.password_hash ?? null
      if (envPw) hash = await this.hashPassword(envPw)
      if (!hash) {
        generated = randomToken(12)
        hash = await this.hashPassword(generated)
      }
      this.insertUser({ username, role: 'admin', vaults: '*' }, hash)
      return generated
    }
    if (envPw && process.env.ADMIN_PASSWORD_RESET === 'true') {
      const u = this.db.get<UserRow>('SELECT * FROM users WHERE username = ?', this.config.admin.username)
      if (u) this.db.run('UPDATE users SET password_hash = ?, disabled = 0, updated = ? WHERE id = ?', await this.hashPassword(envPw), nowIso(), u.id)
      else this.insertUser({ username: this.config.admin.username, role: 'admin', vaults: '*' }, await this.hashPassword(envPw))
    }
    return null
  }

  private async hashPassword(pw: string): Promise<string> {
    if (!pw || pw.length < 8) throw invalid('Das Passwort muss mindestens 8 Zeichen haben.')
    if (pw.length > 256) throw invalid('Das Passwort ist zu lang.')
    return argonHash(pw)
  }

  // ------------------------------------------------------------ Benutzer

  listUsers() {
    return this.db.all<UserRow>('SELECT * FROM users ORDER BY username COLLATE NOCASE').map(publicUser)
  }

  getUser(id: string): UserRow {
    const u = this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id)
    if (!u) throw notFound('Benutzer')
    return u
  }

  private insertUser(input: UserInput, hash: string | null): UserRow {
    const id = ulid()
    const now = nowIso()
    this.db.run(
      'INSERT INTO users (id, username, display_name, password_hash, role, vaults, campaign, disabled, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id,
      input.username!,
      input.display_name ?? null,
      hash,
      input.role ?? 'viewer',
      JSON.stringify(input.vaults ?? '*'),
      input.campaign ?? null,
      input.disabled ? 1 : 0,
      now,
      now,
    )
    return this.getUser(id)
  }

  private validate(input: UserInput) {
    if (input.username !== undefined && !USERNAME_RE.test(input.username)) throw invalid('Benutzername: 2–63 Zeichen, Buchstaben, Ziffern, . _ @ -')
    if (input.role !== undefined && !ROLES.includes(input.role)) throw invalid(`Rolle muss eine von ${ROLES.join(', ')} sein.`)
    if (input.vaults !== undefined && input.vaults !== '*' && !Array.isArray(input.vaults)) throw invalid('vaults muss "*" oder eine Liste sein.')
  }

  async createUser(input: UserInput) {
    this.validate(input)
    if (!input.username) throw invalid('Benutzername fehlt.')
    if (this.db.get('SELECT 1 FROM users WHERE lower(username) = lower(?)', input.username)) throw new ApiError('conflict', 'Benutzername ist bereits vergeben.')
    const hash = input.password ? await this.hashPassword(input.password) : null
    return publicUser(this.insertUser(input, hash))
  }

  private activeAdmins(exceptId?: string): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?", exceptId ?? '')?.n ?? 0
  }

  async updateUser(id: string, input: UserInput) {
    this.validate(input)
    const u = this.getUser(id)
    const demote = (input.role !== undefined && input.role !== 'admin') || input.disabled === true
    if (u.role === 'admin' && !u.disabled && demote && this.activeAdmins(id) === 0) throw new ApiError('conflict', 'Mindestens ein aktiver Admin muss bleiben.')
    if (input.username && input.username.toLowerCase() !== u.username.toLowerCase() && this.db.get('SELECT 1 FROM users WHERE lower(username) = lower(?)', input.username))
      throw new ApiError('conflict', 'Benutzername ist bereits vergeben.')
    const next = {
      username: input.username ?? u.username,
      display_name: input.display_name !== undefined ? input.display_name : u.display_name,
      role: input.role ?? u.role,
      vaults: input.vaults !== undefined ? JSON.stringify(input.vaults) : u.vaults,
      campaign: input.campaign !== undefined ? input.campaign : u.campaign,
      disabled: input.disabled !== undefined ? (input.disabled ? 1 : 0) : u.disabled,
    }
    const hash = input.password ? await this.hashPassword(input.password) : u.password_hash
    this.db.run(
      'UPDATE users SET username = ?, display_name = ?, role = ?, vaults = ?, campaign = ?, disabled = ?, password_hash = ?, updated = ? WHERE id = ?',
      next.username,
      next.display_name,
      next.role,
      next.vaults,
      next.campaign,
      next.disabled,
      hash,
      nowIso(),
      id,
    )
    // Rechte geändert oder gesperrt → bestehende Sitzungen beenden (Passwort-Reset ebenso)
    if (input.password || next.disabled || next.role !== u.role || next.vaults !== u.vaults) this.db.run('DELETE FROM sessions WHERE user_id = ?', id)
    return publicUser(this.getUser(id))
  }

  deleteUser(id: string) {
    const u = this.getUser(id)
    if (u.role === 'admin' && !u.disabled && this.activeAdmins(id) === 0) throw new ApiError('conflict', 'Der letzte Admin kann nicht gelöscht werden.')
    this.db.run('DELETE FROM sessions WHERE user_id = ?', id)
    this.db.run('DELETE FROM users WHERE id = ?', id)
  }

  async changeOwnPassword(userId: string, current: string, next: string, keepSessionId?: string) {
    const u = this.getUser(userId)
    if (!u.password_hash || !(await argonVerify(u.password_hash, current ?? '').catch(() => false))) throw new ApiError('forbidden', 'Aktuelles Passwort ist falsch.')
    this.db.run('UPDATE users SET password_hash = ?, updated = ? WHERE id = ?', await this.hashPassword(next), nowIso(), userId)
    // andere Sitzungen beenden
    this.db.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', userId, keepSessionId ? sha256(keepSessionId) : '')
  }

  // ------------------------------------------------------------ Sitzungen

  async login(username: string, password: string): Promise<{ id: string; csrf: string; expires: string; user: ReturnType<typeof publicUser> }> {
    const u = this.db.get<UserRow>('SELECT * FROM users WHERE lower(username) = lower(?)', username ?? '')
    // Auch bei unbekanntem Benutzer hashen (gleiche Antwortzeit)
    const ok = u?.password_hash ? await argonVerify(u.password_hash, password ?? '').catch(() => false) : (await argonHash('x').catch(() => ''), false)
    if (!u || !ok) throw new ApiError('unauthorized', 'Benutzername oder Passwort falsch.')
    if (u.disabled) throw new ApiError('unauthorized', 'Dieses Konto ist deaktiviert.')
    const id = randomToken(32)
    const csrf = randomToken(24)
    const expires = new Date(Date.now() + this.config.sessionTtlHours * 3600_000).toISOString()
    this.db.run('INSERT INTO sessions (id, username, user_id, csrf, created, expires) VALUES (?,?,?,?,?,?)', sha256(id), u.username, u.id, csrf, nowIso(), expires)
    this.db.run('UPDATE users SET last_login = ? WHERE id = ?', nowIso(), u.id)
    this.db.run('DELETE FROM sessions WHERE expires < ?', new Date().toISOString())
    return { id, csrf, expires, user: publicUser(u) }
  }

  logout(sessionId: string) {
    this.db.run('DELETE FROM sessions WHERE id = ?', sha256(sessionId))
  }

  private userPrincipal(u: UserRow, csrf: string): Principal {
    return {
      kind: 'session',
      name: u.username,
      userId: u.id,
      role: u.role,
      displayName: u.display_name ?? u.username,
      vaults: json<string[] | '*'>(u.vaults, '*'),
      scopes: [...ROLE_SCOPES[u.role]],
      visibility: u.role === 'player' ? 'players' : null,
      campaign: u.campaign ?? null,
      csrf,
    }
  }

  sessionPrincipal(sessionId: string | undefined): Principal | null {
    if (!sessionId) return null
    const row = this.db.get<UserRow & { csrf: string; expires: string }>(
      'SELECT u.*, s.csrf, s.expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?',
      sha256(sessionId),
    )
    if (!row || row.expires < new Date().toISOString() || row.disabled) return null
    return this.userPrincipal(row, row.csrf)
  }

  /** Anmeldung über vorgeschalteten Proxy (Authelia/Authentik), nur wenn AUTH_HEADER gesetzt ist. */
  headerPrincipal(req: FastifyRequest): Principal | null {
    const h = this.config.authHeader
    if (!h) return null
    const name = req.headers[h.toLowerCase()]
    if (typeof name !== 'string' || !name) return null
    const u = this.db.get<UserRow>('SELECT * FROM users WHERE lower(username) = lower(?)', name)
    if (!u || u.disabled) return null
    const csrf = crypto.createHmac('sha256', this.secret).update(`csrf:${u.id}`).digest('base64url')
    return this.userPrincipal(u, csrf)
  }

  // ------------------------------------------------------------ Tokens

  tokenPrincipal(token: string | undefined): Principal | null {
    if (!token) return null
    const row = this.db.get<any>('SELECT * FROM tokens WHERE hash = ?', sha256(token))
    if (!row) return null
    if (row.expires && row.expires < new Date().toISOString()) return null
    if (!row.last_used || Date.now() - Date.parse(row.last_used) > 60_000) this.db.run('UPDATE tokens SET last_used = ? WHERE id = ?', new Date().toISOString(), row.id)
    const grants = row.grants ? json<Grant[] | null>(row.grants, null) : null
    if (grants?.length) {
      return {
        kind: 'token',
        name: row.name,
        vaults: grants.map((g) => g.vault),
        scopes: grants.some((g) => g.access === 'write') ? ['read', 'write'] : ['read'],
        visibility: row.visibility ?? null,
        campaign: null,
        grants,
        tokenId: row.id,
      }
    }
    return {
      kind: 'token',
      name: row.name,
      vaults: json<string[] | '*'>(row.vaults, []),
      scopes: json<Scope[]>(row.scopes, []),
      visibility: row.visibility ?? null,
      campaign: row.campaign ?? null,
      tokenId: row.id,
    }
  }

  createToken(input: {
    name: string
    vaults?: string[] | '*'
    scopes?: Scope[]
    grants?: unknown
    expires?: string | null
    visibility?: string | null
    campaign?: string | null
    kind?: string
  }) {
    if (!input.name?.trim()) throw new ApiError('validation_error', 'Name fehlt.')
    const grants = input.grants !== undefined && input.grants !== null ? normalizeGrants(input.grants) : null
    const scopes = grants ? [] : (input.scopes ?? []).filter((s) => (SCOPES as readonly string[]).includes(s))
    if (!grants && !scopes.length) throw new ApiError('validation_error', `Mindestens ein Scope nötig (${SCOPES.join(', ')}).`)
    const token = `bn_${randomToken(30)}`
    const id = ulid()
    this.db.run(
      'INSERT INTO tokens (id, name, hash, vaults, scopes, visibility, campaign, kind, created, expires, grants) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id,
      input.name.trim(),
      sha256(token),
      JSON.stringify(grants ? grants.map((g) => g.vault) : (input.vaults ?? '*')),
      JSON.stringify(scopes),
      input.visibility ?? null,
      grants ? null : (input.campaign ?? null),
      input.kind ?? 'api',
      nowIso(),
      input.expires ?? null,
      grants ? JSON.stringify(grants) : null,
    )
    return {
      id,
      token,
      name: input.name.trim(),
      vaults: grants ? grants.map((g) => g.vault) : input.vaults,
      scopes,
      grants,
      expires: input.expires ?? null,
      visibility: input.visibility ?? null,
      campaign: grants ? null : (input.campaign ?? null),
    }
  }

  listTokens() {
    this.db.run("DELETE FROM tokens WHERE kind = 'embed' AND expires < ?", new Date().toISOString())
    return this.db.all<any>('SELECT id, name, vaults, scopes, visibility, campaign, kind, created, expires, last_used, grants FROM tokens ORDER BY created DESC').map((r) => ({
      ...r,
      vaults: json(r.vaults, []),
      scopes: json(r.scopes, []),
      grants: r.grants ? json(r.grants, null) : null,
    }))
  }

  /** Freigaben eines bestehenden Zugangs ändern (der Token-Wert bleibt gleich) */
  updateTokenGrants(id: string, grants: unknown) {
    const row = this.db.get<any>('SELECT id FROM tokens WHERE id = ?', id)
    if (!row) throw new ApiError('not_found', 'Token nicht gefunden.')
    const g = normalizeGrants(grants)
    this.db.run('UPDATE tokens SET grants = ?, vaults = ?, scopes = ?, campaign = NULL WHERE id = ?', JSON.stringify(g), JSON.stringify(g.map((x) => x.vault)), '[]', id)
    return this.listTokens().find((t) => t.id === id)
  }

  deleteToken(id: string) {
    const r = this.db.run('DELETE FROM tokens WHERE id = ?', id)
    if (!r.changes) throw new ApiError('not_found', 'Token nicht gefunden.')
  }

  /** Prüft Anmeldung (Bearer, ?token=, Session-Cookie, Proxy-Header) und gibt den Principal zurück. */
  authenticate(req: FastifyRequest): Principal | null {
    const header = req.headers.authorization
    if (header?.startsWith('Bearer ')) {
      const p = this.tokenPrincipal(header.slice(7).trim())
      if (!p) throw new ApiError('unauthorized', 'Token ungültig oder abgelaufen.')
      return p
    }
    const q = (req.query as Record<string, any> | undefined)?.token
    if (typeof q === 'string' && q) {
      const p = this.tokenPrincipal(q)
      if (!p) throw new ApiError('unauthorized', 'Token ungültig oder abgelaufen.')
      return p
    }
    return this.sessionPrincipal(req.cookies?.[SESSION_COOKIE]) ?? this.headerPrincipal(req)
  }
}

/** Prüft Scope + Vault-Zugriff. `inbox` ist in `write` enthalten, `admin` umfasst alles. */
export function requireScope(req: FastifyRequest, scope: Scope, vault?: string) {
  const p = req.principal
  if (!p) throw new ApiError('unauthorized', 'Anmeldung erforderlich.')
  if (p.grants) {
    // Zugang mit Freigaben je Notizbuch: nur Lesen/Schreiben, nie Kurator/Admin
    if (!vault) {
      if (scope === 'read') return
      throw new ApiError('forbidden', `Fehlende Berechtigung: ${scope}.`)
    }
    const g = p.grants.find((x) => x.vault === vault)
    if (!g) throw new ApiError('forbidden', `Kein Zugriff auf den Vault „${vault}“.`)
    if (scope === 'read' || ((scope === 'write' || scope === 'inbox') && g.access === 'write')) return
    throw new ApiError('forbidden', g.access === 'read' && (scope === 'write' || scope === 'inbox') ? 'Dieser Zugang darf nur lesen.' : `Fehlende Berechtigung: ${scope}.`)
  }
  if (vault && p.vaults !== '*' && !p.vaults.includes(vault)) throw new ApiError('forbidden', `Kein Zugriff auf den Vault „${vault}“.`)
  const has = (s: Scope) => p.scopes.includes(s)
  const ok = has('admin') || has(scope) || (scope === 'inbox' && has('write')) || (scope === 'read' && (has('write') || has('curate')))
  if (!ok) throw new ApiError('forbidden', `Fehlende Berechtigung: ${scope}.`)
}

/** Freigabe des Principals für einen Vault (nur bei Zugängen mit Freigaben) */
export function grantFor(req: FastifyRequest, vault: string): Grant | null {
  return req.principal?.grants?.find((g) => g.vault === vault) ?? null
}

/** Erzwungene Sichtbarkeit (Spieler-Konto/-Token) oder gewünschte Sichtbarkeit aus der Anfrage. */
export function effectiveVisibility(req: FastifyRequest, requested?: string): 'dm' | 'players' | undefined {
  if (req.principal?.visibility === 'players') return 'players'
  if (requested === 'players') return 'players'
  return undefined
}

export function setSessionCookie(reply: FastifyReply, id: string, expires: string, secure: boolean) {
  reply.setCookie(SESSION_COOKIE, id, { path: '/', httpOnly: true, sameSite: 'lax', secure, expires: new Date(expires) })
}
