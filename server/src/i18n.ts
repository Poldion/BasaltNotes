/**
 * Sprache der API-Meldungen. Die Meldungen entstehen im Code auf Deutsch; der Fehler-Handler übersetzt sie hier,
 * wenn die Anfrage Englisch wünscht (Kopfzeile `X-Basalt-Lang` der Oberfläche, sonst `Accept-Language`).
 * Meldungen mit eingesetzten Werten werden über Muster erkannt: „Vault „{x}“ …“.
 */
import type { FastifyRequest } from 'fastify'
import { EN } from './locales/en.js'

export type Lang = 'de' | 'en'

export function requestLang(req: FastifyRequest): Lang {
  const h = req.headers['x-basalt-lang']
  const explicit = Array.isArray(h) ? h[0] : h
  if (explicit === 'de' || explicit === 'en') return explicit
  const accept = String(req.headers['accept-language'] ?? '')
    .toLowerCase()
    .split(',')[0]
    ?.trim()
  // Ohne Angabe bleibt es Deutsch (Standard für bestehende Apps wie WhisperNotes)
  return accept && !accept.startsWith('de') && accept !== '*' ? 'en' : 'de'
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Muster mit Platzhaltern einmal übersetzen: längere (spezifischere) zuerst
const PATTERNS = Object.entries(EN)
  .filter(([k]) => k.includes('{x}'))
  .sort((a, b) => b[0].replace(/\{x\}/g, '').length - a[0].replace(/\{x\}/g, '').length)
  .map(([k, v]) => ({ re: new RegExp(`^${k.split('{x}').map(esc).join('([\\s\\S]*?)')}$`), to: v }))

export function translateMessage(message: string, lang: Lang): string {
  if (lang === 'de' || !message) return message
  if (EN[message]) return EN[message]
  for (const p of PATTERNS) {
    const m = p.re.exec(message)
    if (!m) continue
    let i = 1
    return p.to.replace(/\{x\}/g, () => translateMessage(m[i++] ?? '', lang))
  }
  return message
}
