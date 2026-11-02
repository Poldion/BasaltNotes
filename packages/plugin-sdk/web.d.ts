/**
 * BasaltNotes Plugin-SDK – Oberfläche.
 *
 * Das Oberflächen-Modul eines Plugins exportiert als `default` eine Funktion `activate(ctx)`.
 * React, react-router-dom und dieses Modul stellt die App zur Laufzeit bereit (nicht mitbündeln –
 * das Build-Skript der Beispiel-Plugins erledigt das).
 */
import type { ComponentType, ReactNode } from 'react'

export interface WebPluginContext {
  id: string
  /** Seite registrieren. scope "vault": /<vault>/<path>, "global": /p/<path> */
  registerPage(page: { path: string; scope?: 'vault' | 'global'; component: ComponentType; embed?: boolean }): void
  /** Abschnitt auf der Startseite eines Notizbuchs */
  registerHomeSection(section: { id: string; order?: number; component: ComponentType<{ vault: string }> }): void
  /** Eintrag in der Seitenleiste (Notizbuch-Bereich) */
  registerNav(item: { id: string; label: string; icon?: string; path: string; order?: number; visible?: (info: { vault: string; types: string[] }) => boolean }): void
  /** Karte unter Einstellungen */
  registerSettings(card: { id: string; title?: string; adminOnly?: boolean; component: ComponentType }): void
  /** Übersetzungen für tr(): Schlüssel = deutscher Text, z. B. registerTranslations('en', { 'Mein Text': 'My text' }) */
  registerTranslations(lang: 'de' | 'en', dict: Record<string, string>): void
}

export type ActivatePlugin = (ctx: WebPluginContext) => void

// ------------------------------------------------------------ Bausteine der App

export function api<T = any>(path: string, opts?: { method?: string; body?: any; headers?: Record<string, string>; text?: boolean; signal?: AbortSignal }): Promise<T>
export function enc(s: string): string
export function qs(params: Record<string, any>): string

export interface Features {
  curator: boolean
  chat: boolean
  setup_done: boolean
}

export interface AppState {
  me: any
  vaults: { id: string; name: string; preset: string; note_count: number; types: string[] }[]
  canWrite: boolean
  isAdmin: boolean
  embed: boolean
  isPlayer: boolean
  features: Features
  toast(text: string, kind?: 'info' | 'error' | 'success'): void
}
export function useApp(): AppState
export function useTypes(vault: string | undefined): { name: string; label: string; folder: string; properties: { name: string; label: string; type: string }[] }[]
export function useVaultEvents(vault: string | undefined, fn: (e: { event: string; vault: string | null; data: any }) => void): void

export function Modal(props: { title?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; className?: string }): ReactNode
export function Spinner(): ReactNode
export function TypeDot(props: { type: string }): ReactNode
/** Link in einer Einbettung an die umgebende Seite melden; true = erledigt */
export function embedNavigate(noteId: string, title: string, noteType: string): boolean
export function slugify(s: string): string
export function relTime(v?: string | null): string
export function fmtDate(v?: string | null): string
export function fmtDateTime(v?: string | null): string

/**
 * Übersetzen: Der deutsche Text ist der Schlüssel, Platzhalter in geschweiften Klammern.
 * Eigene Übersetzungen eines Plugins: `registerTranslations({ 'Mein Text': 'My text' })` (siehe WebPluginContext).
 */
export function tr(text: string, vars?: Record<string, unknown>): string
/** Aktuelle Sprache der Oberfläche */
export const lang: 'de' | 'en'
/** Gebietsschema für Intl (z. B. 'de-DE', 'en-GB') */
export const locale: string
/**
 * Wo die Oberfläche läuft: im Browser oder in der Android-App. Plugins laufen dort unverändert – Downloads über
 * `<a download>`, Dateiauswahl über `<input type="file">` und `navigator.clipboard` funktionieren in der App ebenfalls.
 */
export const platform: 'web' | 'android'

/**
 * Strich-Symbol der App (passt zu Seitenleiste und Menüs). Namen u. a.: search, home, calendar, chat, inbox, sparkle,
 * log, graph, plus, link, file, upload, edit, trash, stop, refresh, settings, puzzle. In registerNav reicht `icon: 'calendar'`.
 */
export function Icon(props: { name: string; size?: number }): ReactNode
