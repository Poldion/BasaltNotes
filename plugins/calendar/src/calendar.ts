import type { DbApi as Db, Restriction as Access, VaultApi as Vault } from '@basaltnotes/plugin-sdk'
import { H } from './h.js'

/*
 * Kalender: Termine kommen aus Notizen mit Datumsfeld – Typ „Termin“ (start/end), fällige Aufgaben (due),
 * Sessions/Besprechungen (date), Vorbereitungen (planned_for) und eigene Typen mit einem dieser Felder.
 * Uhrzeiten sind Ortszeit (die ersten 16 Zeichen von "2026-10-30T18:00:00+01:00").
 */

export interface CalendarItem {
  /** Eindeutig je Vorkommen: Notiz-ID, bei Wiederholungen mit @Datum */
  id: string
  note_id: string
  vault: string
  title: string
  type: string
  /** "YYYY-MM-DD" (ganztägig) oder "YYYY-MM-DDTHH:mm" */
  start: string
  end: string | null
  all_day: boolean
  location: string | null
  /** Aufgaben: erledigt? */
  done: boolean | null
  status: string | null
  recurrence: string | null
  /** Feld, aus dem das Datum stammt (start, due, date, planned_for …) */
  field: string
}

/** Felder, die einen Termin ausmachen – in dieser Reihenfolge */
const DATE_FIELDS = ['start', 'date', 'due', 'planned_for']

const RECURRENCE: Record<string, 'day' | 'week' | 'month' | 'year'> = {
  täglich: 'day',
  daily: 'day',
  wöchentlich: 'week',
  weekly: 'week',
  monatlich: 'month',
  monthly: 'month',
  jährlich: 'year',
  yearly: 'year',
}

export const DONE = new Set(['erledigt', 'done', 'abgeschlossen', 'gespielt', 'verworfen', 'gescheitert'])

/** Datum/Uhrzeit aus einem Frontmatter-Wert (Ortszeit) */
export function localDateTime(v: unknown): { date: string; time: string | null } | null {
  if (v === null || v === undefined || v === '') return null
  const s = v instanceof Date ? v.toISOString() : String(v).trim()
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(s)
  if (!m) return null
  return { date: m[1], time: m[2] ?? null }
}

export function checkDate(s: unknown, name: string): string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s))) throw H.error('validation_error', `${name} muss ein Datum im Format JJJJ-MM-TT sein.`)
  return s
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000)
}

/** Nächstes Vorkommen nach `date` (Monats-/Jahrestermine am 31./29.2. fallen in kürzeren Monaten aus) */
function step(start: string, unit: 'day' | 'week' | 'month' | 'year', n: number): string | null {
  if (unit === 'day') return addDays(start, n)
  if (unit === 'week') return addDays(start, 7 * n)
  const [y, m, d] = start.split('-').map(Number)
  const total = unit === 'month' ? m - 1 + n : m - 1 + 12 * n
  const ny = y + Math.floor(total / 12)
  const nm = (total % 12) + 1
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate()
  if (d > last) return null
  return `${ny}-${String(nm).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** Typ ohne festgelegte Eigenschaften (z. B. „Notiz“ im freien Vault): das Datum steht frei im Kopf der Notiz */
export function isLooseType(v: Vault, type: string): boolean {
  const t = v.config.types[type]
  return !!t && type !== 'journal' && !t.properties?.length
}

/**
 * Welches Datumsfeld hat dieser Typ? (eigene Typen: erstes Feld vom Typ Datum mit passendem Namen).
 * Bei Typen ohne Eigenschaften entscheidet der Kopf der Notiz (fm).
 */
export function dateFieldOf(v: Vault, type: string, fm?: Record<string, any>): string | null {
  const props = v.config.types[type]?.properties ?? []
  for (const f of DATE_FIELDS) if (props.some((p) => p.name === f && (p.type === 'date' || p.type === 'datetime'))) return f
  if (fm && isLooseType(v, type)) for (const f of DATE_FIELDS) if (fm[f] !== undefined && fm[f] !== null && fm[f] !== '') return f
  return null
}

/** Typen, deren Notizen im Kalender erscheinen können */
export function calendarTypes(v: Vault): string[] {
  return Object.keys(v.config.types).filter((t) => t !== 'journal' && (dateFieldOf(v, t) || isLooseType(v, t)))
}

export function calendarItems(db: Db, v: Vault, from: string, to: string, access?: Access): CalendarItem[] {
  if (daysBetween(from, to) < 0) throw H.error('validation_error', '„to“ liegt vor „from“.')
  if (daysBetween(from, to) > 400) throw H.error('validation_error', 'Höchstens 400 Tage auf einmal.')
  // Tagebuch-Einträge haben ein Datum, sind aber keine Termine
  const types = calendarTypes(v)
  if (!types.length) return []
  const params: any[] = [v.id, ...types]
  const rows = db.all<any>(
    `SELECT n.id, n.title, n.type, n.frontmatter FROM notes n WHERE n.vault = ? AND n.type IN (${types.map(() => '?').join(',')})${H.restrictSql(access, params)}`,
    ...params,
  )
  const out: CalendarItem[] = []
  for (const r of rows) {
    const fm = H.json<Record<string, any>>(r.frontmatter, {})
    const field = dateFieldOf(v, r.type, fm)
    if (!field) continue
    const s = localDateTime(fm[field])
    if (!s) continue
    const e = field === 'start' ? localDateTime(fm.end) : null
    const allDay = fm.all_day === true || String(fm.all_day) === 'true' || !s.time
    const status = fm.status ? String(fm.status) : null
    const isTask = field === 'due'
    const base = {
      note_id: r.id,
      vault: v.id,
      title: r.title,
      type: r.type,
      all_day: allDay,
      location: fm.location ? H.stripLink(fm.location) : null,
      done: isTask ? !!status && DONE.has(status.toLowerCase()) : null,
      status,
      field,
    }
    const fmt = (date: string, time: string | null) => (allDay || !time ? date : `${date}T${time}`)
    // Dauer in Tagen (mehrtägige Termine)
    const span = e && daysBetween(s.date, e.date) > 0 ? daysBetween(s.date, e.date) : 0
    const unit = RECURRENCE[String(fm.recurrence ?? '').toLowerCase()]
    const until = localDateTime(fm.until)?.date ?? null
    if (!unit) {
      if (s.date <= to && addDays(s.date, span) >= from)
        out.push({ ...base, id: r.id, start: fmt(s.date, s.time), end: e ? fmt(e.date, e.time) : null, recurrence: null })
      continue
    }
    for (let i = 0; i < 2000; i++) {
      const d = step(s.date, unit, i)
      if (d === null) continue
      if (d > to || (until && d > until)) break
      if (addDays(d, span) < from) continue
      const endDate = e ? addDays(d, span) : null
      out.push({ ...base, id: `${r.id}@${d}`, start: fmt(d, s.time), end: endDate ? fmt(endDate, e!.time) : null, recurrence: String(fm.recurrence) })
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title, 'de'))
}
