/**
 * Übersetzungen. Der deutsche Text ist zugleich der Schlüssel: tr('Neue Notiz') liefert auf Englisch „New note“,
 * fehlt eine Übersetzung, bleibt der deutsche Text stehen. Platzhalter: tr('{n} Notizen', { n }).
 *
 * Die Sprache wird beim Laden festgelegt (Auswahl im Browser gespeichert, sonst Browsersprache); ein Wechsel lädt die
 * Seite neu – so stimmen auch Texte, die beim Start einmal berechnet werden.
 */
import en from '../locales/en.json'

export type Lang = 'de' | 'en'
export const LANGS: { id: Lang; label: string }[] = [
  { id: 'de', label: 'Deutsch' },
  { id: 'en', label: 'English' },
]

const KEY = 'basalt.lang'
const DICTS: Record<Lang, Record<string, string>> = { de: {}, en: en as Record<string, string> }

function detect(): Lang {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'de' || saved === 'en') return saved
  } catch {
    /* kein Speicher (privates Fenster) */
  }
  const nav = typeof navigator !== 'undefined' ? (navigator.languages?.[0] ?? navigator.language ?? 'de') : 'de'
  return nav.toLowerCase().startsWith('de') ? 'de' : 'en'
}

export const lang: Lang = detect()
/** Für Intl (Datum, Zahlen) */
export const locale = lang === 'de' ? 'de-DE' : 'en-GB'
if (typeof document !== 'undefined') document.documentElement.lang = lang

export function setLang(l: Lang): void {
  try {
    localStorage.setItem(KEY, l)
  } catch {
    /* egal */
  }
  location.reload()
}

/** Weitere Übersetzungen (z. B. von Plugins); vorhandene Einträge bleiben */
export function addTranslations(l: Lang, dict: Record<string, string>): void {
  if (!DICTS[l]) return
  for (const [k, v] of Object.entries(dict)) if (!(k in DICTS[l])) DICTS[l][k] = v
}

export function tr(text: string, vars?: Record<string, unknown>): string {
  const out = DICTS[lang][text] || text
  if (!vars) return out
  return out.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k] ?? '') : m))
}
