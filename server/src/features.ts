import type { FastifyRequest } from 'fastify'
import { readFileConfig, updateFileConfig, type AppConfig } from './config.js'
import type { Db } from './db.js'
import { ApiError } from './lib/errors.js'

/** Schaltbare Funktionen. KI (Kurator, Chat) ist bei einer neuen Einrichtung aus. */
export interface Features {
  curator: boolean
  chat: boolean
  /** Einrichtungsschritt nach dem ersten Login erledigt */
  setup_done: boolean
}

const bool = (v: unknown): boolean | undefined => (v === undefined || v === null || v === '' ? undefined : ['1', 'true', 'yes', 'ja', 'on'].includes(String(v).toLowerCase()))

/**
 * Beim Start: Schalter aus config.yaml lesen. Fehlen sie (erster Start oder Update von einer Version ohne Schalter),
 * werden sie einmalig festgelegt und gespeichert:
 * - Umgebungsvariablen FEATURE_CURATOR / FEATURE_CHAT, falls gesetzt
 * - bestehende Installation (Kurator schon benutzt): an, damit ein Update nichts abschaltet
 * - sonst aus
 */
export function initFeatures(config: AppConfig, db: Db): Features {
  if (config.features) return config.features
  const file = readFileConfig(config.dataDir).features
  if (file && typeof file === 'object') {
    config.features = { curator: !!file.curator, chat: !!file.chat, setup_done: !!file.setup_done }
    return config.features
  }
  const used = (db.get<{ n: number }>('SELECT (SELECT COUNT(*) FROM runs) + (SELECT COUNT(*) FROM inbox) AS n')?.n ?? 0) > 0
  const existing = used || (db.get<{ n: number }>('SELECT COUNT(*) n FROM notes')?.n ?? 0) > 0
  const env = process.env
  config.features = {
    curator: bool(env.FEATURE_CURATOR) ?? used,
    chat: bool(env.FEATURE_CHAT) ?? used,
    setup_done: existing,
  }
  saveFeatures(config)
  return config.features
}

export function saveFeatures(config: AppConfig) {
  const f = config.features!
  updateFileConfig(config.dataDir, (doc) => doc.set('features', { curator: f.curator, chat: f.chat, setup_done: f.setup_done }))
}

const CURATOR_ROUTES = [/^\/vaults\/:vault\/(proposals|runs|curator)(\/|$)/, /^\/vaults\/:vault\/notes\/:id\/curate$/, /^\/vaults\/:vault\/inbox\/:id\/reprocess$/]
const CHAT_ROUTES = [/^\/vaults\/:vault\/chat(\/|$)/]

/** Kurator- und Chat-Funktionen sperren, solange sie ausgeschaltet sind */
export function checkFeatureRoute(req: FastifyRequest, config: AppConfig, prefix: string) {
  const f = config.features
  if (!f) return
  const url = (req.routeOptions?.url ?? '').replace(prefix, '')
  if (!f.curator && CURATOR_ROUTES.some((r) => r.test(url))) throw new ApiError('forbidden', 'Der KI-Kurator ist ausgeschaltet (Einstellungen → Funktionen).', { feature: 'curator' })
  if (!f.chat && CHAT_ROUTES.some((r) => r.test(url))) throw new ApiError('forbidden', 'Der KI-Chat ist ausgeschaltet (Einstellungen → Funktionen).', { feature: 'chat' })
}
