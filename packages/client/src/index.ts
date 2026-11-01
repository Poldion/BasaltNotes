/**
 * @basaltnotes/client – kleiner Client für die BasaltNotes-REST-API.
 *
 * const b = new BasaltNotes({ baseUrl: 'https://notes.home', token })
 * const overview = await b.campaigns.overview('dnd', 'fluch-des-strahd')
 * const html = await b.notes.html('dnd', noteId, { linkBase: '/wiki/{vault}/{id}' })
 * b.events.on('inbox.processed', (e) => toast(`${e.data.created} neue Einträge`))
 */

export interface ClientOptions {
  /** z. B. https://notes.home (ohne /api/v1) */
  baseUrl: string
  /** API-Token (Bearer). Ohne Token wird das Session-Cookie des Browsers genutzt. */
  token?: string
  /** eigenes fetch (z. B. für Tests) */
  fetch?: typeof fetch
}

export class BasaltError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

export type Visibility = 'dm' | 'players'

export interface NoteSummary {
  id: string
  path: string
  type: string
  title: string
  campaign: string | null
  visibility: string | null
  aliases: string[]
  tags: string[]
  updated: string | null
  version: string
  frontmatter?: Record<string, unknown>
  [field: string]: unknown
}

export interface Note extends NoteSummary {
  vault: string
  frontmatter: Record<string, unknown>
  body: string
  raw?: string
  blocks: { key: string; source_note: string | null; visibility: string | null; updated: string | null }[]
  links: { target_id: string | null; text: string; target: string; resolved: boolean; type: string | null }[]
  backlink_count: number
  created: string | null
}

export interface Page<T> {
  items: T[]
  next_cursor: string | null
  total?: number
}

export interface WhereClause {
  field: string
  op?: '=' | '!=' | 'in' | 'not_in' | 'contains' | 'exists' | 'not_exists' | '>' | '<' | '>=' | '<='
  value?: unknown
}

export interface InboxPayload {
  source?: { app?: string; key?: string; url?: string }
  note?: { type?: string; title: string; frontmatter?: Record<string, unknown>; body?: string }
  text?: string
  campaign?: string
  attachments?: { name: string; kind?: string; markdown: string; visibility?: Visibility }[]
  curate?: 'auto' | 'review' | 'none'
}

export interface BasaltEvent {
  event: string
  vault: string | null
  at: string
  data: Record<string, any>
}

type Query = Record<string, string | number | boolean | undefined | null>

function qs(q: Query = {}): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}

const e = encodeURIComponent

export class BasaltNotes {
  private base: string
  private f: typeof fetch

  constructor(private opts: ClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '') + '/api/v1'
    this.f = opts.fetch ?? globalThis.fetch.bind(globalThis)
  }

  /** Roher Aufruf. Wirft BasaltError mit Code aus dem Fehlerformat der API. */
  async request<T = any>(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; text?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) }
    if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`
    let body: BodyInit | undefined
    if (opts.body instanceof FormData) body = opts.body
    else if (opts.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(opts.body)
    }
    const res = await this.f(this.base + path, { method, headers, body, credentials: this.opts.token ? 'omit' : 'include' })
    if (!res.ok) {
      let err: any = null
      try {
        err = await res.json()
      } catch {
        // kein JSON
      }
      throw new BasaltError(res.status, err?.error?.code ?? 'error', err?.error?.message ?? `HTTP ${res.status}`, err?.error?.details)
    }
    if (opts.text) return (await res.text()) as T
    return (await res.json()) as T
  }

  // ------------------------------------------------------------ Vaults
  vaults = {
    list: () => this.request<{ items: any[] }>('GET', '/vaults').then((r) => r.items),
    /** Braucht admin oder create_vault; der anlegende Token hat im neuen Vault alle Rechte */
    create: (vault: { name: string; preset?: 'empty' | 'notes' | 'dnd'; lang?: 'de' | 'en' }) => this.request<any>('POST', '/vaults', { body: vault }),
    delete: (vault: string) => this.request<{ deleted: string }>('DELETE', `/vaults/${e(vault)}`),
    types: (vault: string) => this.request<{ items: any[] }>('GET', `/vaults/${e(vault)}/types`).then((r) => r.items),
  }

  // ------------------------------------------------------------ Notizen
  notes = {
    list: (vault: string, q: Query & { type?: string; campaign?: string; tag?: string; q?: string; fields?: string; limit?: number; cursor?: string } = {}) =>
      this.request<Page<NoteSummary>>('GET', `/vaults/${e(vault)}/notes${qs(q)}`),
    get: (vault: string, id: string, opts: { visibility?: Visibility } = {}) => this.request<Note>('GET', `/vaults/${e(vault)}/notes/${e(id)}${qs(opts)}`),
    byTitle: (vault: string, title: string, opts: { type?: string; campaign?: string } = {}) =>
      this.request<Note>('GET', `/vaults/${e(vault)}/notes/by-title${qs({ title, ...opts })}`),
    byPath: (vault: string, path: string) => this.request<Note>('GET', `/vaults/${e(vault)}/notes/by-path${qs({ path })}`),
    create: (vault: string, note: { type?: string; title: string; frontmatter?: Record<string, unknown>; body?: string; folder?: string }, idempotencyKey?: string) =>
      this.request<Note>('POST', `/vaults/${e(vault)}/notes`, { body: note, headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {} }),
    /** Komplett ersetzen – `version` aus dem letzten Lesen (409 bei Konflikt) */
    replace: (vault: string, id: string, version: string, content: { raw: string } | { frontmatter: Record<string, unknown>; body: string }) =>
      this.request<Note>('PUT', `/vaults/${e(vault)}/notes/${e(id)}`, { body: content, headers: { 'if-match': `"${version}"` } }),
    patch: (vault: string, id: string, patch: { frontmatter?: Record<string, unknown>; remove?: string[]; append?: string | { text: string; heading?: string } }, version?: string) =>
      this.request<Note>('PATCH', `/vaults/${e(vault)}/notes/${e(id)}`, { body: patch, headers: version ? { 'if-match': `"${version}"` } : {} }),
    delete: (vault: string, id: string) => this.request('DELETE', `/vaults/${e(vault)}/notes/${e(id)}`),
    rename: (vault: string, id: string, to: { title?: string; folder?: string }) => this.request<Note & { updated_links: number }>('POST', `/vaults/${e(vault)}/notes/${e(id)}/rename`, { body: to }),
    /** Bereinigtes HTML; linkBase z. B. "/wiki/{vault}/{id}" */
    html: (vault: string, id: string, opts: { linkBase?: string; visibility?: Visibility } = {}) =>
      this.request<string>('GET', `/vaults/${e(vault)}/notes/${e(id)}/html${qs({ link_base: opts.linkBase, visibility: opts.visibility })}`, { text: true }),
    backlinks: (vault: string, id: string, opts: { visibility?: Visibility } = {}) =>
      this.request<{ items: any[] }>('GET', `/vaults/${e(vault)}/notes/${e(id)}/backlinks${qs(opts)}`).then((r) => r.items),
    links: (vault: string, id: string) => this.request<{ items: any[] }>('GET', `/vaults/${e(vault)}/notes/${e(id)}/links`).then((r) => r.items),
    history: (vault: string, id: string) => this.request<{ items: any[] }>('GET', `/vaults/${e(vault)}/notes/${e(id)}/history`).then((r) => r.items),
    curate: (vault: string, id: string, opts: { dryRun?: boolean; mode?: 'auto' | 'review' } = {}) =>
      this.request('POST', `/vaults/${e(vault)}/notes/${e(id)}/curate${qs({ dry_run: opts.dryRun ? 1 : undefined, mode: opts.mode })}`),
  }

  // ------------------------------------------------------------ Verwaltete Bereiche
  blocks = {
    put: (vault: string, noteId: string, key: string, block: { content: string; heading?: string; source_note?: string; visibility?: Visibility }) =>
      this.request<Note>('PUT', `/vaults/${e(vault)}/notes/${e(noteId)}/blocks/${e(key)}`, { body: block }),
    delete: (vault: string, noteId: string, key: string) => this.request('DELETE', `/vaults/${e(vault)}/notes/${e(noteId)}/blocks/${e(key)}`),
    deleteSource: (vault: string, key: string, prefix = false) => this.request('DELETE', `/vaults/${e(vault)}/blocks${qs({ key, prefix: prefix ? 1 : undefined })}`),
  }

  // ------------------------------------------------------------ Suche & Abfragen
  search = (vault: string, q: string, filters: { type?: string; campaign?: string; tag?: string; limit?: number; visibility?: Visibility } = {}) =>
    this.request<Page<NoteSummary & { highlights: string[] }>>('GET', `/vaults/${e(vault)}/search${qs({ q, ...filters })}`)

  query = (vault: string, body: { where?: WhereClause[]; sort?: { field: string; dir?: 'asc' | 'desc' }[]; select?: string[]; limit?: number; cursor?: string }, visibility?: Visibility) =>
    this.request<Page<Record<string, unknown>>>('POST', `/vaults/${e(vault)}/query${qs({ visibility })}`, { body })

  /** Titel + Aliasse, z. B. als Whisper-Glossar */
  names = (vault: string, opts: { campaign?: string; types?: string[] } = {}) =>
    this.request<{ items: { id: string; name: string; type: string; aliases: string[] }[]; glossary: string[] }>(
      'GET',
      `/vaults/${e(vault)}/names${qs({ campaign: opts.campaign, types: opts.types?.join(',') })}`,
    )

  resolve = (vault: string, name: string, opts: { type?: string; campaign?: string } = {}) =>
    this.request<{ items: { id: string; title: string; score: number; match: string }[] }>('GET', `/vaults/${e(vault)}/resolve${qs({ name, ...opts })}`).then((r) => r.items)

  graph = (vault: string, opts: { campaign?: string; type?: string; visibility?: Visibility } = {}) => this.request('GET', `/vaults/${e(vault)}/graph${qs(opts)}`)

  // ------------------------------------------------------------ Eingang & Kurator
  inbox = {
    /** Einliefern. Mit `idempotencyKey` sind Wiederholungen gefahrlos. */
    submit: (vault: string, payload: InboxPayload, idempotencyKey?: string) =>
      this.request<{ inbox_id: string; status: string; note_id: string | null }>('POST', `/vaults/${e(vault)}/inbox`, {
        body: payload,
        headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
      }),
    /** Dokument (PDF, DOCX, TXT, MD) hochladen – Text wird ausgelesen und vom Kurator einsortiert */
    upload: (
      vault: string,
      file: Blob,
      filename: string,
      opts: { title?: string; type?: string; campaign?: string; curate?: 'auto' | 'review' | 'none'; visibility?: Visibility } = {},
    ) => {
      const fd = new FormData()
      for (const [k, v] of Object.entries(opts)) if (v) fd.append(k, String(v))
      fd.append('file', file, filename)
      return this.request<{ inbox_id: string; status: string; note_id: string | null }>('POST', `/vaults/${e(vault)}/inbox/upload`, { body: fd })
    },
    get: (vault: string, id: string) => this.request('GET', `/vaults/${e(vault)}/inbox/${e(id)}`),
    list: (vault: string, status?: string) => this.request<Page<any>>('GET', `/vaults/${e(vault)}/inbox${qs({ status })}`),
    reprocess: (vault: string, id: string) => this.request('POST', `/vaults/${e(vault)}/inbox/${e(id)}/reprocess`),
    cancel: (vault: string, id: string) => this.request<{ inbox_id: string; status: string }>('POST', `/vaults/${e(vault)}/inbox/${e(id)}/cancel`),
  }

  proposals = {
    list: (vault: string, q: { status?: string; campaign?: string; diff?: boolean } = {}) =>
      this.request<Page<any>>('GET', `/vaults/${e(vault)}/proposals${qs({ ...q, diff: q.diff ? 1 : undefined })}`),
    accept: (vault: string, id: string) => this.request('POST', `/vaults/${e(vault)}/proposals/${e(id)}/accept`),
    reject: (vault: string, id: string) => this.request('POST', `/vaults/${e(vault)}/proposals/${e(id)}/reject`),
    bulk: (vault: string, ids: string[], action: 'accept' | 'reject') => this.request('POST', `/vaults/${e(vault)}/proposals/bulk`, { body: { ids, action } }),
  }

  /** Kurator-Status und Stoppen */
  curator = {
    status: (vault: string) => this.request<{ running: any[]; queued: number }>('GET', `/vaults/${e(vault)}/curator/status`),
    stop: (vault: string) => this.request<{ stopped_running: number; cancelled_queued: number }>('POST', `/vaults/${e(vault)}/curator/stop`),
    /** Duplikate ohne LLM suchen und als Zusammenführ-Vorschläge anlegen */
    duplicates: (vault: string, opts: { dryRun?: boolean; minScore?: number } = {}) =>
      this.request<{ found: number; known: number; created: number; pairs: any[] }>(
        'POST',
        `/vaults/${e(vault)}/curator/duplicates${qs({ dry_run: opts.dryRun ? 1 : undefined, min_score: opts.minScore })}`,
      ),
  }

  /** Mit den Notizen chatten (passende Einträge werden ohne LLM vorausgewählt) */
  chat = {
    ask: (vault: string, question: string, opts: { history?: { role: 'user' | 'assistant'; content: string }[]; previous?: string[]; focus?: string[]; campaign?: string; includeContext?: boolean } = {}) =>
      this.request<{ answer: string; llm: boolean; sources: { id: string; title: string; type: string; role: string; reason: string }[]; focus: string[]; chars: number; budget: number; context?: string }>(
        'POST',
        `/vaults/${e(vault)}/chat`,
        { body: { question, history: opts.history, previous: opts.previous, focus: opts.focus, campaign: opts.campaign, include_context: opts.includeContext } },
      ),
    /** Nur den Kontext bestimmen, der an das LLM gehen würde */
    context: (vault: string, question: string, opts: { previous?: string[]; focus?: string[]; campaign?: string } = {}) =>
      this.request<{ question: string; focus: string[]; sources: any[]; text: string; chars: number; budget: number; list_types: string[] }>('POST', `/vaults/${e(vault)}/chat/context`, { body: { question, ...opts } }),
  }

  runs = {
    list: (vault: string) => this.request<Page<any>>('GET', `/vaults/${e(vault)}/runs`),
    get: (vault: string, id: string) => this.request('GET', `/vaults/${e(vault)}/runs/${e(id)}`),
    revert: (vault: string, id: string) => this.request('POST', `/vaults/${e(vault)}/runs/${e(id)}/revert`),
  }

  // ------------------------------------------------------------ Kampagnen (DM-Panel)
  campaigns = {
    list: (vault: string) => this.request<{ items: any[] }>('GET', `/vaults/${e(vault)}/campaigns`).then((r) => r.items),
    overview: (vault: string, campaign: string, opts: { visibility?: Visibility } = {}) =>
      this.request('GET', `/vaults/${e(vault)}/campaigns/${e(campaign)}/overview${qs(opts)}`),
    timeline: (vault: string, campaign: string, opts: { visibility?: Visibility } = {}) =>
      this.request<{ campaign: string; items: any[] }>('GET', `/vaults/${e(vault)}/campaigns/${e(campaign)}/timeline${qs(opts)}`).then((r) => r.items),
  }

  /** Kurzlebiges Token für iframe-Einbettungen (vom Gast-Server holen, nicht im Browser) */
  embedToken = (vault: string, opts: { ttl?: number; scope?: 'read' | 'write'; visibility?: Visibility; campaign?: string } = {}) =>
    this.request<{ token: string; expires: string }>('POST', '/tokens/embed', { body: { vault, ...opts } })

  health = () => this.request('GET', '/health')

  // ------------------------------------------------------------ Live-Ereignisse (SSE über fetch – Browser und Node)
  events = {
    /**
     * Abonniert Ereignisse (z. B. "inbox.processed" oder "*"). Gibt eine Abmelde-Funktion zurück.
     * Verbindet bei Abbruch automatisch neu.
     */
    on: (event: string, handler: (e: BasaltEvent) => void, opts: { vault?: string } = {}): (() => void) => {
      const ctrl = new AbortController()
      const connect = async () => {
        while (!ctrl.signal.aborted) {
          try {
            const headers: Record<string, string> = { accept: 'text/event-stream' }
            if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`
            const res = await this.f(`${this.base}/events${qs({ vault: opts.vault })}`, { headers, signal: ctrl.signal, credentials: this.opts.token ? 'omit' : 'include' })
            if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
            const reader = res.body.getReader()
            const dec = new TextDecoder()
            let buf = ''
            for (;;) {
              const { value, done } = await reader.read()
              if (done) break
              buf += dec.decode(value, { stream: true })
              let i: number
              while ((i = buf.indexOf('\n\n')) >= 0) {
                const chunk = buf.slice(0, i)
                buf = buf.slice(i + 2)
                const name = /^event: (.+)$/m.exec(chunk)?.[1]
                const data = /^data: (.+)$/m.exec(chunk)?.[1]
                if (!name || !data || name === 'ready') continue
                if (event === '*' || event === name) {
                  try {
                    handler(JSON.parse(data))
                  } catch {
                    // fehlerhafte Nachricht ignorieren
                  }
                }
              }
            }
          } catch {
            if (ctrl.signal.aborted) return
          }
          await new Promise((r) => setTimeout(r, 3000))
        }
      }
      void connect()
      return () => ctrl.abort()
    },
  }
}

export default BasaltNotes
