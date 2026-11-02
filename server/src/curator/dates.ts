/** Datumsangaben aus LLM-Antworten und Protokollen in das Format der Notizen bringen (Kalender liest nur JJJJ-MM-TT[THH:mm]) */

const MONTHS: Record<string, number> = {
  januar: 1, jan: 1, january: 1, februar: 2, feb: 2, february: 2, märz: 3, maerz: 3, mär: 3, march: 3, mar: 3, april: 4, apr: 4, mai: 5, may: 5,
  juni: 6, jun: 6, june: 6, juli: 7, jul: 7, july: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9, oktober: 10, okt: 10, october: 10, oct: 10,
  november: 11, nov: 11, dezember: 12, dez: 12, december: 12, dec: 12,
}

const ISO = /\b(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/
const NUMERIC = /\b(\d{1,2})\.\s?(\d{1,2})\.(?:\s?(\d{4}|\d{2})(?!\d|[:.]\d))?/
const NAMED = /\b(\d{1,2})\.\s?([A-Za-zÄÖÜäöü]{3,9})\.?(?:\s+(\d{4}))?/
const WEEKDAY = /\b(?:mo|di|mi|do|fr|sa|so|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)\b\.?,?\s*(?:den\s+)?$/i

export interface ParsedDate {
  date: string
  time: string | null
  /** Fundstelle des Datums im Text */
  index: number
  length: number
}

const pad = (n: number) => String(n).padStart(2, '0')

function valid(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
}

/** Ohne Jahr: das nächste Vorkommen ab heute */
function yearFor(m: number, d: number, today: string): number {
  const y = Number(today.slice(0, 4))
  return `${y}-${pad(m)}-${pad(d)}` < today ? y + 1 : y
}

function timeIn(text: string): string | null {
  const m = /\b(\d{1,2})[:.](\d{2})\s*(?:uhr|h)?\b/i.exec(text) ?? /\b(\d{1,2})()\s*uhr\b/i.exec(text)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2] || 0)
  return h < 24 && min < 60 ? `${pad(h)}:${pad(min)}` : null
}

/** Erstes Datum im Text, z. B. „Di, 03.11.2026 um 14 Uhr“, „3. November“ oder „2026-11-03T14:00“ */
export function parseDate(text: string, today = new Date().toISOString().slice(0, 10)): ParsedDate | null {
  let date: string | null = null
  let hit: RegExpExecArray | null = ISO.exec(text)
  let time: string | null = null
  if (hit) {
    if (valid(Number(hit[1]), Number(hit[2]), Number(hit[3]))) date = `${hit[1]}-${hit[2]}-${hit[3]}`
    if (hit[4]) time = `${hit[4]}:${hit[5]}`
  }
  if (!date && (hit = NUMERIC.exec(text))) {
    const d = Number(hit[1])
    const m = Number(hit[2])
    const y = hit[3] ? (hit[3].length === 2 ? 2000 + Number(hit[3]) : Number(hit[3])) : yearFor(m, d, today)
    if (valid(y, m, d)) date = `${y}-${pad(m)}-${pad(d)}`
  }
  if (!date && (hit = NAMED.exec(text))) {
    const m = MONTHS[hit[2].toLowerCase()]
    const d = Number(hit[1])
    if (m) {
      const y = hit[3] ? Number(hit[3]) : yearFor(m, d, today)
      if (valid(y, m, d)) date = `${y}-${pad(m)}-${pad(d)}`
    }
  }
  if (!date || !hit) return null
  return { date, time: time ?? timeIn(text.slice(0, hit.index) + ' ' + text.slice(hit.index + hit[0].length)), index: hit.index, length: hit[0].length }
}

/** Wert für ein Datumsfeld; nicht erkennbare Angaben (z. B. Datum einer Spielwelt) bleiben unverändert */
export function normalizeDateValue(value: string, kind: 'date' | 'datetime', today?: string): string {
  const p = parseDate(value, today)
  if (!p) return value
  return kind === 'datetime' && p.time ? `${p.date}T${p.time}` : p.date
}

/** Termine aus einem Abschnitt „## Termine“, wie ihn Protokolle mitbringen */
export function eventsFromText(text: string, today?: string): { title: string; line: string; start: string }[] {
  const out: { title: string; line: string; start: string }[] = []
  let inside = false
  for (const raw of text.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.*)$/.exec(raw.trim())
    if (heading) {
      inside = /^(termine?|events?|appointments?)\b/i.test(heading[1].replace(/\*/g, '').trim())
      continue
    }
    const bullet = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(raw)
    if (!inside || !bullet) continue
    const line = bullet[1].replace(/\*\*|__/g, '').trim()
    const p = parseDate(line, today)
    if (!p) continue
    const before = line.slice(0, p.index).replace(WEEKDAY, '').replace(/[\s,:;–—-]+$/, '')
    const after = line.slice(p.index + p.length).replace(/^\s*(?:(?:um\s+)?\d{1,2}(?:[:.]\d{2})?\s*(?:uhr|h)\b|(?:um\s+)?\d{1,2}[:.]\d{2})?/i, '').replace(/^[\s,:;–—-]+/, '')
    const title = shorten([before, after].filter(Boolean).join(' – ').replace(/[.\s]+$/, ''))
    out.push({ title: title || `Termin am ${p.date}`, line, start: p.time ? `${p.date}T${p.time}` : p.date })
  }
  return out
}

function shorten(s: string): string {
  if (s.length <= 80) return s
  const cut = s.slice(0, 77)
  return `${cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : 77)} …`
}
