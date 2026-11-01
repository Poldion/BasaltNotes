import { lang, tr } from './i18n'
/** API-Client: Session-Cookie + CSRF oder Token aus der URL (Einbettungen, Spieler-Links). */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: any,
  ) {
    super(message)
  }
}

const params = new URLSearchParams(location.search)
let token: string | null = params.get('token')
let csrf: string | null = null

export function setCsrf(v: string | null) {
  csrf = v
}
export function getToken() {
  return token
}
export function setToken(t: string | null) {
  token = t
}

export interface RequestOpts {
  method?: string
  body?: any
  headers?: Record<string, string>
  /** Antwort als Text statt JSON */
  text?: boolean
  signal?: AbortSignal
}

export async function api<T = any>(path: string, opts: RequestOpts = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET')
  const headers: Record<string, string> = { 'x-basalt-lang': lang, ...(opts.headers ?? {}) }
  let body: BodyInit | undefined
  if (opts.body instanceof FormData) body = opts.body
  else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  if (token) headers.authorization = `Bearer ${token}`
  else if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf
  const res = await fetch(`/api/v1${path}`, { method, headers, body, credentials: 'same-origin', signal: opts.signal })
  if (!res.ok) {
    let err: any = null
    try {
      err = await res.json()
    } catch {
      // kein JSON
    }
    if (res.status === 401 && !token && !path.startsWith('/auth/')) window.dispatchEvent(new CustomEvent('basalt:unauthorized'))
    throw new ApiError(res.status, err?.error?.code ?? 'error', err?.error?.message ?? tr('Fehler {status}', { status: res.status }), err?.error?.details)
  }
  if (opts.text) return (await res.text()) as T
  if (res.status === 204) return undefined as T
  return res.json()
}

export const enc = encodeURIComponent

export function qs(params: Record<string, any>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}

/** URL für EventSource / Bilder (Token als Query, da keine Header möglich). */
export function withToken(url: string): string {
  if (!token) return url
  return url + (url.includes('?') ? '&' : '?') + 'token=' + enc(token)
}

// ------------------------------------------------------------ Typen

export interface NoteSummary {
  id: string
  path: string
  type: string
  title: string
  campaign?: string | null
  visibility?: string | null
  aliases?: string[]
  updated?: string | null
}

export interface Note extends NoteSummary {
  vault: string
  tags: string[]
  aliases: string[]
  frontmatter: Record<string, any>
  body: string
  raw?: string
  blocks: { key: string; source_note: string | null; visibility: string | null; updated: string | null }[]
  links: { target_id: string | null; text: string; target: string; heading: string | null; resolved: boolean; attachment?: boolean; type: string | null }[]
  backlink_count: number
  version: string
  created: string | null
}

export interface PropDef {
  name: string
  label: string
  type: 'text' | 'number' | 'date' | 'datetime' | 'select' | 'link' | 'list' | 'players' | 'boolean' | 'url'
  options?: string[]
  link_types?: string[]
}

export interface TypeSchema {
  name: string
  label: string
  folder: string
  template: string | null
  single_note: string | null
  properties: PropDef[]
}

export interface VaultInfo {
  id: string
  name: string
  preset: string
  /** Das Profil des Vaults kennt eine eingeschränkte Sicht */
  restricted_view?: boolean
  note_count: number
  types: string[]
  curator: { enabled: boolean; profile: string; mode: 'full' | 'link' }
  open_proposals: number
  inbox_pending: number
}

export interface Me {
  kind: 'session' | 'token'
  name: string
  user_id: string | null
  display_name: string
  role: 'admin' | 'member' | 'editor' | 'viewer' | 'player' | null
  roles: { name: string; label: string }[]
  vaults: string[] | '*'
  scopes: string[]
  /** Rechte je Vault („*“ = alle) */
  access?: { vault: string; rights: string[]; area?: boolean }[]
  server_admin?: boolean
  visibility: 'players' | null
  campaign: string | null
  csrf: string | null
  embed_origins?: string[]
  /** Eingeschaltete Funktionen */
  features?: Features
}

export interface Features {
  curator: boolean
  chat: boolean
  setup_done: boolean
}

/** POST mit Antwort als Server-Sent Events (z. B. Chat): ruft `onEvent` für jedes Ereignis auf. */
export async function apiStream(path: string, body: unknown, onEvent: (event: string, data: any) => void, signal?: AbortSignal): Promise<void> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream', 'x-basalt-lang': lang }
  if (token) headers.authorization = `Bearer ${token}`
  else if (csrf) headers['x-csrf-token'] = csrf
  const res = await fetch(`/api/v1${path}`, { method: 'POST', headers, body: JSON.stringify(body), credentials: 'same-origin', signal })
  if (!res.ok || !res.body) {
    let err: any = null
    try {
      err = await res.json()
    } catch {
      // kein JSON
    }
    throw new ApiError(res.status, err?.error?.code ?? 'error', err?.error?.message ?? tr('Fehler {status}', { status: res.status }), err?.error?.details)
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const flush = (chunk: string) => {
    let event = 'message'
    const data: string[] = []
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    if (data.length) onEvent(event, JSON.parse(data.join('\n')))
  }
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i: number
    while ((i = buf.indexOf('\n\n')) >= 0) {
      flush(buf.slice(0, i))
      buf = buf.slice(i + 2)
    }
  }
  if (buf.trim()) flush(buf)
}
