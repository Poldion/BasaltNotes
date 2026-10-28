import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import YAML from 'yaml'
import type { ThinkMode } from './curator/llm.js'
import type { Features } from './features.js'

export interface LlmConfig {
  url: string
  model?: string
  num_ctx?: number
  /** Höchstens so lange auf das erste Token warten */
  timeout_ms: number
  /** Höchstens so lange ohne neues Token */
  idle_ms: number
  retries: number
  /** Höchstens so viele Zeichen Notizen gehen pro Chat-Frage an das LLM */
  chat_context_chars?: number
  /** Nachdenken im Chat bzw. beim Kurator (Standard: aus) */
  think_chat?: ThinkMode
  think_curator?: ThinkMode
}

export interface AppConfig {
  dataDir: string
  port: number
  host: string
  baseUrl: string
  llm: LlmConfig
  corsOrigins: string[]
  embedOrigins: string[]
  admin: { username: string; password_hash?: string }
  /** Geheimnis für abgeleitete Werte (wird beim ersten Start erzeugt) */
  secret?: string
  /** Optional: Benutzername aus Header des Reverse-Proxys (z. B. Remote-User von Authelia) */
  authHeader?: string
  sessionTtlHours: number
  trustProxy: boolean
  watch: boolean
  commitDelayMs: number
  /** Schaltbare Funktionen (KI-Kurator, KI-Chat) – wird beim Start aus config.yaml gesetzt */
  features?: Features
}

/** Dateiinhalt von /data/config.yaml (alles optional, Umgebungsvariablen haben Vorrang). */
interface FileConfig {
  base_url?: string
  llm?: Partial<LlmConfig>
  cors_origins?: string[]
  embed_origins?: string[]
  admin?: { username?: string; password_hash?: string }
  session_ttl_hours?: number
  secret?: string
  auth_header?: string
  /** In der Oberfläche gesetzt (Einstellungen → LLM) – hat Vorrang vor Umgebungsvariablen */
  llm_override?: LlmOverride
  features?: Partial<Features>
}

export interface LlmOverride {
  url?: string
  /** leer = aktuell geladenes Modell */
  model?: string
  /** 0/leer = automatisch */
  num_ctx?: number
  think_chat?: ThinkMode
  think_curator?: ThinkMode
}

function list(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  return value.split(',').map((s) => s.trim()).filter(Boolean)
}

export function thinkMode(value: unknown): ThinkMode {
  const v = String(value ?? '').trim().toLowerCase()
  if (v === 'true' || v === 'on' || v === 'an') return 'on'
  return v === 'low' || v === 'medium' || v === 'high' ? v : 'off'
}

function num(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

export function configPath(dataDir: string): string {
  return path.join(dataDir, 'config.yaml')
}

export function readFileConfig(dataDir: string): FileConfig {
  const file = configPath(dataDir)
  if (!fs.existsSync(file)) return {}
  return (YAML.parse(fs.readFileSync(file, 'utf8')) as FileConfig) ?? {}
}

/** Schreibt einzelne Werte in config.yaml und behält Kommentare bei. */
export function updateFileConfig(dataDir: string, mutate: (doc: YAML.Document) => void): void {
  const file = configPath(dataDir)
  const doc = fs.existsSync(file) ? YAML.parseDocument(fs.readFileSync(file, 'utf8')) : new YAML.Document({})
  mutate(doc)
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, doc.toString(), 'utf8')
  fs.renameSync(tmp, file)
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const env = process.env
  const dataDir = path.resolve(overrides.dataDir ?? env.DATA_DIR ?? './data')
  fs.mkdirSync(path.join(dataDir, 'vaults'), { recursive: true })
  const file = readFileConfig(dataDir)
  const port = num(env.PORT) ?? 8080
  const cfg: AppConfig = {
    dataDir,
    port,
    host: env.HOST ?? '0.0.0.0',
    baseUrl: env.BASE_URL ?? file.base_url ?? `http://localhost:${port}`,
    llm: {
      url: file.llm_override?.url || env.LLM_URL || file.llm?.url || 'http://localhost:11434',
      model: file.llm_override && 'model' in file.llm_override ? file.llm_override.model || undefined : (env.LLM_MODEL ?? file.llm?.model),
      num_ctx: file.llm_override && 'num_ctx' in file.llm_override ? file.llm_override.num_ctx || undefined : (num(env.LLM_NUM_CTX) ?? file.llm?.num_ctx),
      timeout_ms: num(env.LLM_TIMEOUT_MS) ?? file.llm?.timeout_ms ?? 600_000,
      idle_ms: num(env.LLM_IDLE_TIMEOUT_MS) ?? file.llm?.idle_ms ?? 120_000,
      retries: num(env.LLM_RETRIES) ?? file.llm?.retries ?? 2,
      chat_context_chars: num(env.LLM_CHAT_CONTEXT_CHARS) ?? file.llm?.chat_context_chars ?? 6000,
      think_chat: thinkMode(file.llm_override?.think_chat ?? env.LLM_THINK_CHAT ?? file.llm?.think_chat),
      think_curator: thinkMode(file.llm_override?.think_curator ?? env.LLM_THINK_CURATOR ?? file.llm?.think_curator),
    },
    corsOrigins: list(env.CORS_ORIGINS) ?? file.cors_origins ?? [],
    embedOrigins: list(env.EMBED_ORIGINS) ?? file.embed_origins ?? list(env.CORS_ORIGINS) ?? file.cors_origins ?? [],
    admin: { username: env.ADMIN_USER ?? file.admin?.username ?? 'admin', password_hash: file.admin?.password_hash },
    secret: file.secret,
    authHeader: env.AUTH_HEADER || file.auth_header || undefined,
    sessionTtlHours: num(env.SESSION_TTL_HOURS) ?? file.session_ttl_hours ?? 24 * 30,
    trustProxy: env.TRUST_PROXY !== 'false',
    watch: env.WATCH_FILES !== 'false',
    commitDelayMs: num(env.COMMIT_DELAY_MS) ?? 5000,
    ...overrides,
  }
  return cfg
}
