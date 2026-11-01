import crypto from 'node:crypto'
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { ulid } from 'ulid'
import { Db, json, nowIso } from './db.js'
import { ApiError, invalid, notFound } from './lib/errors.js'
import { randomToken, sha256 } from './lib/util.js'
import { AppConfig, updateFileConfig } from './config.js'

export const SCOPES = ['read', 'write', 'inbox', 'curate', 'admin', 'create_vault'] as const
export type Scope = (typeof SCOPES)[number]

/** member = Rechte je Notizbuch wie bei Tokens; editor und viewer sind die älteren Rollen dafür */
export const ROLES = ['admin', 'member', 'editor', 'viewer', 'player'] as const
export type Role = (typeof ROLES)[number]

/** Rechte je Rolle. „player“ sieht nur Inhalte mit visibility: players. */
export const ROLE_SCOPES: Record<Role, Scope[]> = {
  admin: [...SCOPES],
  member: [],
  editor: ['read', 'write', 'inbox', 'curate'],
  viewer: ['read'],
  player: ['read'],
}

/** So viele eigene Vaults darf ein Token ohne admin-Recht anlegen */
export const MAX_OWNED_VAULTS = 20

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administration',
  member: 'Mitglied',
  editor: 'Bearbeiten',
  viewer: 'Lesen',
  player: 'Spieler (nur Spieler-Inhalte)',
}

/** Rechte-Stufen einer Freigabe. Alle Zugänge werden über dieselben Scopes geprüft (siehe requireScope). */
export const ACCESS_LEVELS = {
  read: ['read'],
  inbox: ['inbox'],
  read_inbox: ['read', 'inbox'],
  curate: ['read', 'inbox', 'curate'],
  write: ['read', 'write', 'inbox'],
  write_curate: ['read', 'write', 'inbox', 'curate'],
  admin: ['read', 'write', 'inbox', 'curate', 'admin'],
} as const satisfies Record<string, readonly Scope[]>
export type AccessLevel = keyof typeof ACCESS_LEVELS

/** Stufe, die klassische Scopes (scopes + vaults) in der Oberfläche darstellt */
function levelOfScopes(scopes: Scope[]): AccessLevel | null {
  const has = (s: Scope) => scopes.includes(s)
  if (has('admin')) return 'admin'
  if (has('write')) return has('curate') ? 'write_curate' : 'write'
  if (has('curate')) return 'curate'
  if (has('inbox')) return has('read') ? 'read_inbox' : 'inbox'
  return has('read') ? 'read' : null
}

/**
 * Freigabe eines Notizbuchs (Vault) für einen API-Zugang: eine Rechte-Stufe, optional beschränkt
 * auf einen Bereich (Kampagne, Ordner, Typen). vault „*“ = alle Notizbücher.
 */
export interface Grant {
  vault: string
  access: AccessLevel
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
export function normalizeGrants(input: unknown, allowEmpty = false): Grant[] {
  if (!Array.isArray(input)) throw invalid('grants muss eine Liste sein.')
  const out: Grant[] = []
  for (const raw of input) {
    const g = raw as any
    const vault = String(g?.vault ?? '').trim()
    if (!vault) throw invalid('Jede Freigabe braucht ein Notizbuch (vault).')
    if (!Object.hasOwn(ACCESS_LEVELS, g.access)) throw invalid(`access muss eine von ${Object.keys(ACCESS_LEVELS).join(', ')} sein.`)
    if (out.some((x) => x.vault === vault)) throw invalid(`Notizbuch „${vault}“ ist doppelt freigegeben.`)
    const list = (v: unknown) =>
      (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [])
        .map((x) => String(x).trim().replace(/^\/+|\/+$/g, ''))
        .filter(Boolean)
    const folders = list(g.folders)
    if (folders.some((f) => f.split('/').includes('..'))) throw invalid('Ungültiger Ordner.')
    const types = list(g.types)
    const campaign = g.campaign ? String(g.campaign).trim() : null
    if (campaign || folders.length || types.length) {
      // Kurator und Verwaltung sehen den ganzen Vault – das passt nicht zu einem Bereich
      if (vault === '*') throw invalid('Eine Freigabe für alle Notizbücher kann nicht auf einen Bereich beschränkt werden.')
      if ((ACCESS_LEVELS[g.access as AccessLevel] as readonly Scope[]).includes('curate')) throw invalid('Kurator- und Verwaltungsrechte gehen nicht zusammen mit einem Bereich.')
    }
    out.push({ vault, access: g.access, ...(campaign ? { campaign, shared: g.shared !== false } : {}), ...(folders.length ? { folders } : {}), ...(types.length ? { types } : {}) })
  }
  if (!out.length && !allowEmpty) throw invalid('Mindestens ein Notizbuch freigeben.')
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
  /** Das eine Rechte-Modell: welche Rechte in welchem Vault („*“ = alle). Daraus prüft requireScope. */
  access: { vault: string; rights: readonly Scope[] }[]
  /** Freigaben je Notizbuch – liefern den Bereich (Kampagne, Ordner, Typen) */
  grants?: Grant[] | null
  /** Vaults, die dieser Token selbst angelegt hat – dort hat er alle Rechte */
  ownedVaults?: string[]
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
  grants: string | null
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

function userGrants(u: UserRow): Grant[] | null {
  return u.role === 'member' ? json<Grant[]>(u.grants ?? '[]', []) : null
}

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    role: u.role,
    vaults: json<string[] | '*'>(u.vaults, '*'),
    grants: userGrants(u),
    // Einheitliche Sicht auf die Rechte, auch bei Rollen
    access: userGrants(u) ?? (json<string[] | '*'>(u.vaults, '*') === '*' ? ['*'] : json<string[]>(u.vaults, [])).map((vault) => ({ vault, access: levelOfScopes(ROLE_SCOPES[u.role]) ?? 'read', ...(u.campaign ? { campaign: u.campaign, shared: true } : {}) })),
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
  /** Rechte je Notizbuch, nur für die Rolle member */
  grants?: unknown
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
      'INSERT INTO users (id, username, display_name, password_hash, role, vaults, grants, campaign, disabled, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id,
      input.username!,
      input.display_name ?? null,
      hash,
      input.role ?? 'viewer',
      input.role === 'member' ? JSON.stringify(normalizeGrants(input.grants ?? [], true).map((g) => g.vault)) : JSON.stringify(input.vaults ?? '*'),
      input.role === 'member' ? JSON.stringify(normalizeGrants(input.grants ?? [], true)) : null,
      input.role === 'member' ? null : (input.campaign ?? null),
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
      grants: null as string | null,
      campaign: input.campaign !== undefined ? input.campaign : u.campaign,
      disabled: input.disabled !== undefined ? (input.disabled ? 1 : 0) : u.disabled,
    }
    if (next.role === 'member') {
      const grants = normalizeGrants(input.grants ?? (u.role === 'member' ? json(u.grants ?? '[]', []) : []), true)
      next.grants = JSON.stringify(grants)
      next.vaults = JSON.stringify(grants.map((g) => g.vault))
      next.campaign = null
    }
    const hash = input.password ? await this.hashPassword(input.password) : u.password_hash
    this.db.run(
      'UPDATE users SET username = ?, display_name = ?, role = ?, vaults = ?, grants = ?, campaign = ?, disabled = ?, password_hash = ?, updated = ? WHERE id = ?',
      next.username,
      next.display_name,
      next.role,
      next.vaults,
      next.grants,
      next.campaign,
      next.disabled,
      hash,
      nowIso(),
      id,
    )
    // Rechte geändert oder gesperrt → bestehende Sitzungen beenden (Passwort-Reset ebenso)
    if (input.password || next.disabled || next.role !== u.role || next.vaults !== u.vaults || next.grants !== u.grants) this.db.run('DELETE FROM sessions WHERE user_id = ?', id)
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
    const grants = userGrants(u)
    if (grants) {
      const access = grants.map((g) => ({ vault: g.vault, rights: ACCESS_LEVELS[g.access] as readonly Scope[] }))
      return {
        kind: 'session',
        name: u.username,
        userId: u.id,
        role: u.role,
        displayName: u.display_name ?? u.username,
        vaults: grants.some((g) => g.vault === '*') ? '*' : grants.map((g) => g.vault),
        scopes: [...new Set(access.flatMap((x) => x.rights))],
        access,
        grants,
        visibility: null,
        campaign: null,
        csrf,
      }
    }
    return {
      kind: 'session',
      name: u.username,
      userId: u.id,
      role: u.role,
      displayName: u.display_name ?? u.username,
      vaults: json<string[] | '*'>(u.vaults, '*'),
      scopes: [...ROLE_SCOPES[u.role]],
      access: accessOfVaults(json<string[] | '*'>(u.vaults, '*'), ROLE_SCOPES[u.role]),
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
    const ownedVaults = json<string[]>(row.owned_vaults, [])
    const stored = json<Scope[]>(row.scopes, [])
    if (grants?.length) {
      const access = grants.map((g) => ({ vault: g.vault, rights: ACCESS_LEVELS[g.access] as readonly Scope[] }))
      const owned = ownedVaults.map((vault) => ({ vault, rights: ACCESS_LEVELS.admin as readonly Scope[] }))
      return {
        kind: 'token',
        name: row.name,
        vaults: grants.some((g) => g.vault === '*') ? '*' : [...new Set([...grants.map((g) => g.vault), ...ownedVaults])],
        scopes: [...new Set([...access.flatMap((x) => x.rights), ...stored.filter((s) => s === 'create_vault')])],
        access: [...access, ...owned],
        ownedVaults,
      visibility: row.visibility ?? null,
        campaign: null,
        grants,
        tokenId: row.id,
      }
    }
    const vaults = json<string[] | '*'>(row.vaults, [])
    return {
      kind: 'token',
      name: row.name,
      vaults: vaults === '*' ? '*' : [...new Set([...vaults, ...ownedVaults])],
      scopes: stored,
      access: [...accessOfVaults(vaults, stored), ...ownedVaults.map((vault) => ({ vault, rights: ACCESS_LEVELS.admin as readonly Scope[] }))],
      ownedVaults,
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
    const onlyCreate = input.scopes?.includes('create_vault') && Array.isArray(input.grants) && !input.grants.length
    const grants = input.grants !== undefined && input.grants !== null && !onlyCreate ? normalizeGrants(input.grants) : null
    const scopes = (input.scopes ?? []).filter((s) => (SCOPES as readonly string[]).includes(s) && (!grants || s === 'create_vault'))
    if (!grants && !scopes.length) throw new ApiError('validation_error', `Mindestens ein Scope nötig (${SCOPES.join(', ')}).`)
    // Eigene Vaults hätten sonst Sichtbarkeit oder Kampagne ohne Sinn
    if (scopes.includes('create_vault') && (input.visibility || input.campaign)) throw invalid('create_vault geht nicht zusammen mit visibility oder campaign.')
    // Nur create_vault: sieht ausschließlich die eigenen Vaults, auch in der Vault-Liste
    const vaults = scopes.length === 1 && scopes[0] === 'create_vault' && !grants ? [] : input.vaults
    const token = `bn_${randomToken(30)}`
    const id = ulid()
    this.db.run(
      'INSERT INTO tokens (id, name, hash, vaults, scopes, visibility, campaign, kind, created, expires, grants) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id,
      input.name.trim(),
      sha256(token),
      JSON.stringify(grants ? grants.map((g) => g.vault) : (vaults ?? '*')),
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
      vaults: grants ? grants.map((g) => g.vault) : vaults,
      scopes,
      grants,
      expires: input.expires ?? null,
      visibility: input.visibility ?? null,
      campaign: grants ? null : (input.campaign ?? null),
    }
  }

  listTokens() {
    this.db.run("DELETE FROM tokens WHERE kind = 'embed' AND expires < ?", new Date().toISOString())
    return this.db.all<any>('SELECT id, name, vaults, scopes, visibility, campaign, kind, created, expires, last_used, grants, owned_vaults FROM tokens ORDER BY created DESC').map((r) => {
      const grants = r.grants ? json<Grant[] | null>(r.grants, null) : null
      const vaults = json<string[] | '*'>(r.vaults, [])
      const scopes = json<Scope[]>(r.scopes, [])
      const level = levelOfScopes(scopes)
      return {
        ...r,
        vaults,
        scopes,
        grants,
        owned_vaults: json(r.owned_vaults, []),
        create_vault: scopes.includes('create_vault'),
        // Einheitliche Sicht auf die Rechte, auch für klassisch angelegte Tokens
        access: grants ?? (level ? (vaults === '*' ? ['*'] : vaults).map((vault) => ({ vault, access: level, ...(r.campaign ? { campaign: r.campaign, shared: true } : {}) })) : []),
      }
    })
  }

  /** Zugang nachträglich ändern (der Token-Wert bleibt gleich). Nicht für Embed- und Spieler-Links. */
  updateToken(id: string, input: { name?: string; grants?: unknown; create_vault?: boolean; expires?: string | null }) {
    const row = this.db.get<any>('SELECT * FROM tokens WHERE id = ?', id)
    if (!row) throw new ApiError('not_found', 'Token nicht gefunden.')
    if (row.kind !== 'api') throw new ApiError('conflict', 'Eingebettete Zugänge und Spieler-Links lassen sich nicht ändern, nur widerrufen.')
    if (input.name !== undefined && !input.name.trim()) throw invalid('Name fehlt.')
    const stored = json<Scope[]>(row.scopes, [])
    const create = input.create_vault ?? stored.includes('create_vault')
    if (create && row.visibility) throw invalid('create_vault geht nicht zusammen mit visibility oder campaign.')
    const grants = input.grants !== undefined ? normalizeGrants(input.grants, create) : undefined
    let scopes: Scope[] = stored.filter((s) => s !== 'create_vault')
    if (grants) scopes = []
    if (create) scopes = [...scopes, 'create_vault']
    if (!grants && !row.grants && !scopes.length) throw invalid('Mindestens ein Notizbuch freigeben.')
    if (grants === undefined && create && row.campaign) throw invalid('create_vault geht nicht zusammen mit visibility oder campaign.')
    this.db.run(
      'UPDATE tokens SET name = ?, expires = ?, scopes = ?, grants = ?, vaults = ?, campaign = ? WHERE id = ?',
      input.name?.trim() ?? row.name,
      input.expires !== undefined ? input.expires : row.expires,
      JSON.stringify(scopes),
      grants ? (grants.length ? JSON.stringify(grants) : null) : row.grants,
      grants ? JSON.stringify(grants.map((g) => g.vault)) : row.vaults,
      grants ? null : row.campaign,
      id,
    )
    return this.listTokens().find((t) => t.id === id)
  }

  /** Vault dem Token zuordnen, der ihn angelegt hat */
  addOwnedVault(tokenId: string, vault: string) {
    const row = this.db.get<any>('SELECT owned_vaults FROM tokens WHERE id = ?', tokenId)
    if (!row) return
    this.db.run('UPDATE tokens SET owned_vaults = ? WHERE id = ?', JSON.stringify([...new Set([...json<string[]>(row.owned_vaults, []), vault])]), tokenId)
  }

  /** Beim Löschen eines Vaults: Ein späterer Vault mit gleichem Namen gehört nicht automatisch dem alten Token */
  forgetOwnedVault(vault: string) {
    for (const row of this.db.all<any>("SELECT id, owned_vaults FROM tokens WHERE owned_vaults != '[]'")) {
      const owned = json<string[]>(row.owned_vaults, [])
      if (owned.includes(vault)) this.db.run('UPDATE tokens SET owned_vaults = ? WHERE id = ?', JSON.stringify(owned.filter((v) => v !== vault)), row.id)
    }
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

function accessOfVaults(vaults: string[] | '*', scopes: readonly Scope[]) {
  const rights = scopes.filter((s) => s !== 'create_vault')
  return (vaults === '*' ? ['*'] : vaults).map((vault) => ({ vault, rights }))
}

/** `inbox` ist in `write` enthalten, `read` in `write` und `curate`, `admin` umfasst alles. */
function rightsAllow(rights: readonly Scope[], scope: Scope): boolean {
  const has = (s: Scope) => rights.includes(s)
  return has('admin') || has(scope) || (scope === 'inbox' && has('write')) || (scope === 'read' && (has('write') || has('curate')))
}

/** Darf den Server verwalten (Benutzer, Tokens, Webhooks …): Admin-Konto oder Admin-Recht für alle Notizbücher */
export function isServerAdmin(p: Principal): boolean {
  return p.role === 'admin' || p.access.some((x) => x.vault === '*' && x.rights.includes('admin'))
}

/** Die eine Rechte-Prüfung für Konten und Tokens: Scope im Vault, ohne Vault serverweit. */
export function requireScope(req: FastifyRequest, scope: Scope, vault?: string) {
  const p = req.principal
  if (!p) throw new ApiError('unauthorized', 'Anmeldung erforderlich.')
  if (scope === 'admin' || scope === 'create_vault') {
    if (!vault && (isServerAdmin(p) || (scope === 'create_vault' && p.scopes.includes('create_vault')))) return
    if (!vault) throw new ApiError('forbidden', `Fehlende Berechtigung: ${scope}.`)
  }
  if (!vault) {
    if (p.access.some((x) => rightsAllow(x.rights, scope))) return
    throw new ApiError('forbidden', `Fehlende Berechtigung: ${scope}.`)
  }
  const entries = p.access.filter((x) => x.vault === vault || x.vault === '*')
  if (!entries.length) throw new ApiError('forbidden', `Kein Zugriff auf den Vault „${vault}“.`)
  if (entries.some((x) => rightsAllow(x.rights, scope))) return
  throw new ApiError('forbidden', p.grants && (scope === 'write' || scope === 'inbox') && entries.every((x) => !x.rights.includes('inbox')) ? 'Dieser Zugang darf nur lesen.' : `Fehlende Berechtigung: ${scope}.`)
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
