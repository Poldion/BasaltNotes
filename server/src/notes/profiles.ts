import type { Db } from '../db.js'
import type { Vault } from './vault.js'

/** Wörter, an denen der Chat Übersichtsfragen nach einem Typ erkennt (Plugins ergänzen eigene) */
export const CHAT_TYPE_WORDS: Record<string, string[]> = {
  person: ['person', 'personen', 'kontakt', 'kontakte'],
  project: ['projekt', 'projekte'],
  meeting: ['meeting', 'meetings', 'besprechung', 'besprechungen', 'termin', 'termine'],
  task: ['aufgabe', 'aufgaben', 'todo', 'todos'],
  location: ['ort', 'orte', 'stadt', 'städte'],
  quest: ['aufgabe', 'aufgaben'],
}
/** Wörter, die allein keinen Eintrag bezeichnen */
export const CHAT_GENERIC_WORDS = new Set<string>([...Object.values(CHAT_TYPE_WORDS).flat(), 'teil', 'kapitel', 'notiz', 'notizen'])

export interface ProfileContext {
  v: Vault
  db: Db
  slugify(s: string): string
}

/**
 * Regelwerk eines Vaults für Kurator, Eingang und Chat. Der Kern hat ein allgemeines Verhalten;
 * Plugins bringen eigene Profile mit (vault.yaml: curator.profile).
 */
export interface VaultProfile {
  id: string
  /** Typen, die der Kurator nicht als Einträge erkennt */
  nonEntityTypes?: string[]
  /** Bei widersprüchlichen Typen für denselben Namen gewinnt der frühere */
  entityRank?: string[]
  /** Neue Einträge gehören zur Gruppe des Eingangs (Feld campaign) */
  scoped?: boolean
  /** Es gibt eine eingeschränkte Sicht (Feld visibility, Bereiche mit visibility="dm") */
  restrictedView?: boolean
  /** Systemprompt der Erkennung */
  systemPrompt?(c: { group: string | null | undefined; types: string; hasType(t: string): boolean; knownNames: string; hint: string }): string
  /** Sonderregeln für eine Quellnotiz */
  sourceRules?(note: { type: string }): { hint?: string; restricted?: boolean } | null
  /** Namen, die keine Aliasse von Einträgen sind */
  excludedNames?(c: ProfileContext & { frontmatter?: Record<string, any>; group: string | null }): string[]
  /** Typ für Eingangsnotizen ohne Typ */
  defaultInboxType?: string
  /** Gruppe des Eingangs zuordnen und bei Bedarf anlegen */
  resolveGroup?(c: ProfileContext & { name: string | null | undefined }): Promise<string | null>
  /** Felder einer Eingangsnotiz ergänzen */
  inboxFrontmatter?(c: ProfileContext & { type: string; group: string | null; frontmatter: Record<string, any>; isNew: boolean }): void
  /** Standardwerte für hochgeladene Dokumente */
  documentDefaults?(c: { v: Vault; visibility?: 'dm' | 'players' }): { type?: string; visibility?: 'dm' | 'players' }
  /** Worum es im Chat geht („Du beantwortest Fragen zu …“) */
  chatSubject?: string
  /** Wörter für Übersichtsfragen */
  typeWords?: Record<string, string[]>
  genericWords?: string[]
}

const registry = new Map<string, VaultProfile>()

export function registerProfile(p: VaultProfile) {
  registry.set(p.id, p)
  for (const [t, words] of Object.entries(p.typeWords ?? {})) {
    CHAT_TYPE_WORDS[t] = [...new Set([...(CHAT_TYPE_WORDS[t] ?? []), ...words])]
    for (const w of words) CHAT_GENERIC_WORDS.add(w)
  }
  for (const w of p.genericWords ?? []) CHAT_GENERIC_WORDS.add(w)
}

export function profileOf(v: { config: { curator: { profile: string } } }): VaultProfile | undefined {
  return registry.get(v.config.curator.profile)
}
