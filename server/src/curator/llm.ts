import type { LlmConfig } from '../config.js'
import { ApiError, CancelledError, isCancelled } from '../lib/errors.js'
import { Mutex, sleep } from '../lib/util.js'

/** Nachdenken („Thinking“) bei Modellen, die es können (qwen3, deepseek-r1, gpt-oss …) */
export type ThinkMode = 'off' | 'on' | 'low' | 'medium' | 'high'
export const THINK_MODES: ThinkMode[] = ['off', 'on', 'low', 'medium', 'high']

/** Zusätzliche Antwort-Tokens, damit das Nachdenken die eigentliche Antwort nicht abschneidet */
export function thinkReserve(mode: ThinkMode | undefined): number {
  return mode === 'low' ? 1024 : mode === 'on' || mode === 'medium' ? 2048 : mode === 'high' ? 4096 : 0
}

/** Wert für Ollamas "think": false, true oder eine Stufe (gpt-oss) */
function thinkValue(mode: ThinkMode | undefined): boolean | string {
  return !mode || mode === 'off' ? false : mode === 'on' ? true : mode
}

/** Wenn der Server/das Modell den Wert ablehnt: Stufe → an → aus → gar nicht senden (ältere Ollama-Versionen) */
function nextThink(t: boolean | string | undefined): boolean | string | undefined {
  return typeof t === 'string' ? true : t === true ? false : undefined
}

/** Antworttext ohne <think>…</think> (Modelle, die das Nachdenken in den Text schreiben) */
export function splitThink(raw: string): { thinking: string; text: string; pending: boolean } {
  const t = raw.replace(/^\s+/, '')
  if (!t.startsWith('<think>')) {
    if (t.length < 7 && '<think>'.startsWith(t)) return { thinking: '', text: '', pending: true }
    return { thinking: '', text: raw, pending: false }
  }
  const end = t.indexOf('</think>')
  if (end < 0) return { thinking: t.slice(7), text: '', pending: false }
  return { thinking: t.slice(7, end), text: t.slice(end + 8).replace(/^\s+/, ''), pending: false }
}

export interface LlmInfo {
  url: string
  reachable: boolean
  model: string | null
  context: number
  context_source: 'config' | 'api_ps' | 'proxy_state' | 'api_show' | 'default'
  error?: string
  checked: string
}

function sameModel(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false
  const norm = (s: string) => s.trim().toLowerCase().replace(/:latest$/, '')
  return norm(a) === norm(b)
}

function proxyContext(state: any, model: string | null): number | null {
  if (!state || typeof state !== 'object') return null
  if (Array.isArray(state.models) && state.models.length) {
    let entry = model ? state.models.find((m: any) => sameModel(m?.alias, model) || sameModel(m?.model, model)) : undefined
    if (!entry && state.default_model) {
      entry = state.models.find((m: any) => sameModel(m?.model, state.default_model) || sameModel(m?.alias, state.default_model))
    }
    if (!entry && !model) entry = state.models[0]
    const n = Number(entry?.forced_options?.num_ctx ?? entry?.num_ctx)
    if (n > 0) return n
  }
  const n = Number(state.forced_options?.num_ctx)
  return n > 0 ? n : null
}

export interface ChatJsonOptions {
  system: string
  user: string
  schema?: object
  temperature?: number
  /** Reserve für die Antwort in Tokens */
  reserveTokens?: number
  /** Abbruch (Kurator stoppen) – trennt die Verbindung zum LLM */
  signal?: AbortSignal
  /** Fortschritt: Anzahl bisher erzeugter Tokens */
  onToken?: (tokens: number) => void
}

export interface ChatTextOptions {
  system: string
  /** Bisheriger Verlauf + aktuelle Frage */
  messages: { role: 'user' | 'assistant'; content: string }[]
  temperature?: number
  /** Höchstzahl erzeugter Tokens */
  reserveTokens?: number
  signal?: AbortSignal
  /** Wird aufgerufen, sobald das LLM frei ist (vorher wartet die Anfrage hinter dem Kurator) */
  onStart?: () => void
  /** Jedes neue Textstück */
  onText?: (piece: string) => void
  /** Jedes neue Stück des Nachdenkens (falls eingeschaltet) */
  onThinking?: (piece: string) => void
}

export interface LlmClient {
  info(force?: boolean): Promise<LlmInfo>
  chatJson<T = any>(opts: ChatJsonOptions): Promise<T>
  /** Freier Text (gestreamt), z. B. für den Chat mit den Notizen */
  chatText(opts: ChatTextOptions): Promise<string>
  /** Zwischengespeicherte Infos verwerfen (nach Änderung von Adresse/Modell) */
  reset?(): void
  /** Zeichenbudget für die Eingabe (Kontext − Systemprompt − Antwortreserve) × ~3 Zeichen/Token */
  inputBudget(systemChars: number, reserveTokens?: number, purpose?: 'chat' | 'curator'): Promise<number>
}

const CHARS_PER_TOKEN = 3

export class OllamaClient implements LlmClient {
  private cache: LlmInfo | null = null
  private cacheAt = 0
  private queue = new Mutex()

  constructor(private cfg: LlmConfig) {}

  reset(): void {
    this.cache = null
    this.cacheAt = 0
  }

  private async getJson(path: string, timeoutMs = 5000): Promise<{ status: number; body: any }> {
    const res = await fetch(new URL(path, this.cfg.url), { signal: AbortSignal.timeout(timeoutMs) })
    let body: any = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    return { status: res.status, body }
  }

  private async postJson(path: string, payload: unknown, timeoutMs = 5000): Promise<{ status: number; body: any }> {
    const res = await fetch(new URL(path, this.cfg.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    let body: any = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    return { status: res.status, body }
  }

  async info(force = false): Promise<LlmInfo> {
    if (!force && this.cache && Date.now() - this.cacheAt < 60_000) return this.cache
    const info: LlmInfo = { url: this.cfg.url, reachable: false, model: this.cfg.model ?? null, context: 4096, context_source: 'default', checked: new Date().toISOString() }
    let psContext: number | null = null
    try {
      // 1. Aktives Modell: /api/ps, bei 404 /api/tags
      const ps = await this.getJson('/api/ps')
      if (ps.status === 200 && Array.isArray(ps.body?.models) && ps.body.models.length) {
        info.reachable = true
        const m = info.model
          ? ps.body.models.find((x: any) => sameModel(x.name, info.model) || sameModel(x.model, info.model))
          : ps.body.models[0]
        if (!info.model && m) info.model = m.name ?? m.model ?? null
        if (m) psContext = Number(m.context_length ?? m.details?.context_length) || null
      } else {
        const tags = await this.getJson('/api/tags')
        if (tags.status === 200) {
          info.reachable = true
          const models = Array.isArray(tags.body?.models) ? tags.body.models : []
          if (!info.model && models.length) info.model = models[0].name ?? models[0].model ?? null
        } else {
          info.error = `HTTP ${tags.status} von /api/tags`
        }
      }
      // 2. Kontextgröße: Konfiguration > /api/ps (für das aktive Modell) > Proxy /admin/state > /api/show > 4096
      if (this.cfg.num_ctx) {
        info.context = this.cfg.num_ctx
        info.context_source = 'config'
      } else if (psContext) {
        info.context = psContext
        info.context_source = 'api_ps'
      } else {
        let found = false
        try {
          const st = await this.getJson('/admin/state')
          const n = st.status === 200 ? proxyContext(st.body, info.model) : null
          if (n && n > 0) {
            info.context = n
            info.context_source = 'proxy_state'
            found = true
          }
        } catch {
          // kein Proxy
        }
        if (!found && info.model) {
          try {
            const sh = await this.postJson('/api/show', { name: info.model })
            const m = sh.status === 200 ? /^\s*num_ctx\s+(\d+)/m.exec(String(sh.body?.parameters ?? '')) : null
            const n = m ? Number(m[1]) : 0
            if (n > 0) {
              info.context = n
              info.context_source = 'api_show'
            }
          } catch {
            // /api/show nicht verfügbar
          }
        }
      }
    } catch (e) {
      info.error = (e as Error).message
      if (this.cfg.num_ctx) {
        info.context = this.cfg.num_ctx
        info.context_source = 'config'
      }
    }
    this.cache = info
    this.cacheAt = Date.now()
    return info
  }

  async inputBudget(systemChars: number, reserveTokens = 1536, purpose: 'chat' | 'curator' = 'curator'): Promise<number> {
    const { context } = await this.info()
    const think = thinkReserve(purpose === 'chat' ? this.cfg.think_chat : this.cfg.think_curator)
    const tokens = context - Math.ceil(systemChars / CHARS_PER_TOKEN) - reserveTokens - think
    return Math.max(1500, tokens * CHARS_PER_TOKEN)
  }

  chatJson<T = any>(opts: ChatJsonOptions): Promise<T> {
    // Der Proxy hält nur ein Modell: Aufrufe streng nacheinander
    return this.queue.run(() => {
      if (opts.signal?.aborted) throw new CancelledError()
      return this.chatJsonUnqueued<T>(opts)
    })
  }

  private async requireModel(): Promise<{ model: string; context: number }> {
    const info = await this.info()
    if (!info.reachable || !info.model) {
      const fresh = await this.info(true)
      if (!fresh.reachable || !fresh.model) throw new ApiError('llm_unavailable', `LLM nicht erreichbar (${fresh.error ?? this.cfg.url}).`, { reason: 'unreachable' })
    }
    const cur = await this.info()
    return { model: cur.model!, context: cur.context }
  }

  chatText(opts: ChatTextOptions): Promise<string> {
    return this.queue.run(async () => {
      if (opts.signal?.aborted) throw new CancelledError()
      opts.onStart?.()
      const { model, context } = await this.requireModel()
      let think: boolean | string | undefined = thinkValue(this.cfg.think_chat)
      for (;;) {
        const body: any = {
          model,
          stream: true,
          messages: [{ role: 'system', content: opts.system }, ...opts.messages],
          options: { temperature: opts.temperature ?? 0.2, num_ctx: context, num_predict: (opts.reserveTokens ?? 700) + thinkReserve(this.cfg.think_chat) },
          keep_alive: '30m',
        }
        if (think !== undefined) body.think = think
        // Nachdenken im Text (<think>…</think>) vom Antworttext trennen
        let raw = ''
        let sentThink = 0
        let sentText = 0
        const onText = (piece: string) => {
          raw += piece
          const sp = splitThink(raw)
          if (sp.pending) return
          if (sp.thinking.length > sentThink) opts.onThinking?.(sp.thinking.slice(sentThink))
          if (sp.text.length > sentText) opts.onText?.(sp.text.slice(sentText))
          sentThink = sp.thinking.length
          sentText = sp.text.length
        }
        try {
          await this.streamChat(body, { signal: opts.signal, onText, onThinking: opts.onThinking, allowTruncated: true })
          return splitThink(raw).text
        } catch (e) {
          if (opts.signal?.aborted || isCancelled(e)) throw new CancelledError()
          const err = e as LlmCallError
          if (err.status === 400 && /think/i.test(err.message) && think !== undefined) {
            think = nextThink(think)
            continue
          }
          this.cache = null
          throw new ApiError('llm_unavailable', err.message, { reason: err.reason === 'first' || err.reason === 'idle' ? 'timeout' : 'unreachable' })
        }
      }
    })
  }

  private async chatJsonUnqueued<T>(opts: ChatJsonOptions): Promise<T> {
    const { model, context } = await this.requireModel()
    let lastErr: Error | null = null
    let think: boolean | string | undefined = thinkValue(this.cfg.think_curator)
    for (let attempt = 0; attempt <= this.cfg.retries; attempt++) {
      if (opts.signal?.aborted) throw new CancelledError()
      const body: any = {
        model,
        stream: true,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
        format: opts.schema ?? 'json',
        options: { temperature: opts.temperature ?? 0.15, num_ctx: context, num_predict: (opts.reserveTokens ?? 1536) + thinkReserve(this.cfg.think_curator) },
        keep_alive: '30m',
      }
      if (think !== undefined) body.think = think
      let content: string
      try {
        content = await this.streamChat(body, opts)
      } catch (e) {
        if (opts.signal?.aborted || isCancelled(e)) throw new CancelledError()
        const err = e as LlmCallError
        // Modell kann kein Nachdenken bzw. ältere Ollama-Version kennt "think" nicht
        if (err.status === 400 && /think/i.test(err.message) && think !== undefined) {
          think = nextThink(think)
          attempt--
          continue
        }
        // Zeitüberschreitung oder abgeschnittene Antwort: Wiederholen bringt nichts
        if (err.reason === 'first' || err.reason === 'idle' || err.reason === 'truncated') {
          throw Object.assign(new ApiError('llm_unavailable', err.message, { reason: err.reason === 'truncated' ? 'truncated' : 'timeout' }), { noRetry: true })
        }
        lastErr = err
        this.cache = null
        if (attempt < this.cfg.retries) await sleep(1500 * (attempt + 1))
        continue
      }
      try {
        return parseJsonLoose(content) as T
      } catch {
        throw Object.assign(new ApiError('llm_unavailable', 'Die Antwort des LLM war kein gültiges JSON (vermutlich abgeschnitten).', { reason: 'parse' }), { noRetry: true })
      }
    }
    throw new ApiError('llm_unavailable', `LLM-Aufruf fehlgeschlagen: ${lastErr?.message}`, { reason: 'unreachable' })
  }

  /**
   * Antwort per Streaming lesen. Statt eines festen Gesamt-Zeitlimits gilt:
   * - bis zum ersten Token höchstens `timeout_ms` (Einlesen des Textes, ggf. Warten hinter anderen Anfragen)
   * - danach höchstens `idle_ms` ohne neues Token.
   * Langsame Modelle sind damit kein Problem, solange sie liefern.
   */
  private async streamChat(
    body: any,
    opts: { signal?: AbortSignal; onToken?: (n: number) => void; onText?: (piece: string) => void; onThinking?: (piece: string) => void; allowTruncated?: boolean },
  ): Promise<string> {
    const ctrl = new AbortController()
    const onAbort = () => ctrl.abort()
    opts.signal?.addEventListener('abort', onAbort)
    let reason: 'first' | 'idle' | null = null
    let timer: NodeJS.Timeout | undefined
    const arm = (ms: number, r: 'first' | 'idle') => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        reason = r
        ctrl.abort()
      }, ms)
    }
    arm(this.cfg.timeout_ms, 'first')
    let content = ''
    let tokens = 0
    let doneReason: string | null = null
    const handle = (obj: any) => {
      if (obj?.error) throw Object.assign(new Error(String(obj.error)), { status: 500 })
      // Nachdenken kommt getrennt vom Text – zählt als Lebenszeichen, gehört aber nicht zur Antwort
      const thought: string = obj?.message?.thinking ?? obj?.thinking ?? ''
      if (thought) {
        tokens++
        opts.onToken?.(tokens)
        opts.onThinking?.(thought)
        arm(this.cfg.idle_ms, 'idle')
      }
      const piece: string = obj?.message?.content ?? obj?.response ?? ''
      if (piece) {
        content += piece
        tokens++
        opts.onToken?.(tokens)
        opts.onText?.(piece)
        arm(this.cfg.idle_ms, 'idle')
      }
      if (obj?.done) doneReason = obj.done_reason ?? 'stop'
    }
    try {
      const res = await fetch(new URL('/api/chat', this.cfg.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
      if (!res.ok) {
        const text = await res.text()
        throw Object.assign(new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`), { status: res.status })
      }
      if (!res.body) throw new Error('Leere Antwort')
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (line) handle(JSON.parse(line))
        }
      }
      if (buf.trim()) handle(JSON.parse(buf.trim()))
      if (doneReason === 'length' && !opts.allowTruncated) {
        throw Object.assign(new Error(`Die Antwort wurde nach ${tokens} Tokens abgeschnitten (Antwortgrenze erreicht).`), { reason: 'truncated' })
      }
      return content
    } catch (e) {
      if (reason === 'first') {
        throw Object.assign(new Error(`Das LLM hat innerhalb von ${Math.round(this.cfg.timeout_ms / 60000)} min nicht zu antworten begonnen (belegt oder zu langsam beim Einlesen).`), { reason })
      }
      if (reason === 'idle') {
        throw Object.assign(new Error(`Das LLM hat nach ${tokens} Tokens ${Math.round(this.cfg.idle_ms / 1000)} s lang nichts mehr geliefert.`), { reason })
      }
      throw e
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
  }
}

interface LlmCallError extends Error {
  status?: number
  reason?: 'first' | 'idle' | 'truncated'
}

/** JSON aus einer Modellantwort lesen (verträgt ```json-Blöcke und Text drumherum). */
export function parseJsonLoose(content: string): any {
  const trimmed = content.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    // weiter unten
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)
  if (fence) {
    try {
      return JSON.parse(fence[1])
    } catch {
      // weiter
    }
  }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1))
  throw new Error('Antwort ist kein JSON')
}
