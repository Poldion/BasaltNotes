import crypto from 'node:crypto'

/*
 * Minimaler iCalendar-Baukasten (RFC 5545) für CalDAV: nur was Kalender- und To-do-Apps
 * (Home Assistant, iOS/Android, Thunderbird) zum Anzeigen und Bearbeiten brauchen.
 */

/** Zeitzone für Ortszeiten (TZ des Containers, sonst Europe/Berlin) */
export function timeZone(): string {
  const tz = process.env.TIMEZONE || process.env.TZ
  if (tz && tz !== 'UTC') {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz })
      return tz
    } catch {
      // ungültig
    }
  }
  return 'Europe/Berlin'
}

/** Versatz in Minuten einer Zeitzone zu einem UTC-Zeitpunkt */
function offsetAt(tz: string, utcMs: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, p.value]),
  )
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second))
  return Math.round((asUtc - utcMs) / 60000)
}

const pad = (n: number) => String(n).padStart(2, '0')
const fmtOffset = (min: number) => `${min >= 0 ? '+' : '-'}${pad(Math.trunc(Math.abs(min) / 60))}:${pad(Math.abs(min) % 60)}`

/** UTC-Zeitpunkt → Ortszeit mit Versatz "2026-11-03T09:30:00+01:00" */
export function utcToLocal(utcMs: number, tz = timeZone()): string {
  const off = offsetAt(tz, utcMs)
  const d = new Date(utcMs + off * 60000)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00${fmtOffset(off)}`
}

/** Ortszeit (Wanduhr) in einer Zeitzone → UTC-Millisekunden */
export function localToUtc(date: string, time: string, tz = timeZone()): number {
  const guess = Date.parse(`${date}T${time}:00Z`)
  const off = offsetAt(tz, guess - offsetAt(tz, guess) * 60000)
  return guess - off * 60000
}

/** Gespeicherter Wert ("2026-11-03T09:30:00+01:00" oder ohne Versatz) → UTC-ms */
export function storedToUtc(v: string, tz = timeZone()): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?/.exec(v)
  if (!m) return null
  if (m[4]) return Date.parse(`${m[1]}T${m[2]}:${m[3] ?? '00'}${m[4].length === 5 ? m[4].slice(0, 3) + ':' + m[4].slice(3) : m[4]}`)
  return localToUtc(m[1], m[2], tz)
}

// ------------------------------------------------------------ Schreiben

function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}

/** Zeilen auf 75 Oktette falten */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8')
  if (bytes.length <= 75) return line
  const out: string[] = []
  let cur = ''
  let len = 0
  for (const ch of line) {
    const l = Buffer.byteLength(ch)
    if (len + l > (out.length ? 74 : 75)) {
      out.push(cur)
      cur = ''
      len = 0
    }
    cur += ch
    len += l
  }
  out.push(cur)
  return out.join('\r\n ')
}

const utcStamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
const dateValue = (d: string) => d.replace(/-/g, '')

export interface IcalEvent {
  uid: string
  summary: string
  /** "YYYY-MM-DD" (ganztägig) oder gespeicherter Zeitwert */
  start: string
  end?: string | null
  allDay: boolean
  location?: string | null
  description?: string | null
  /** day | week | month | year */
  rrule?: { freq: 'day' | 'week' | 'month' | 'year'; until?: string | null } | null
  lastModified?: string | null
  /** Einzelnes Vorkommen einer Serie (bei Auflösung durch den Server) */
  recurrenceId?: string | null
}

export interface IcalTodo {
  uid: string
  summary: string
  done: boolean
  due?: string | null
  description?: string | null
  lastModified?: string | null
  priority?: number | null
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function dt(name: string, v: string, allDay: boolean): string {
  if (allDay || v.length === 10) return `${name};VALUE=DATE:${dateValue(v.slice(0, 10))}`
  const ms = storedToUtc(v)
  return ms === null ? `${name};VALUE=DATE:${dateValue(v.slice(0, 10))}` : `${name}:${utcStamp(ms)}`
}

const FREQ: Record<string, string> = { day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' }

export function eventLines(e: IcalEvent): string[] {
  const lines = ['BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${utcStamp(Date.now())}`]
  lines.push(dt('DTSTART', e.start, e.allDay))
  if (e.allDay) {
    // Ende ist bei ganztägigen Terminen exklusiv
    const end = e.end && e.end.slice(0, 10) >= e.start.slice(0, 10) ? e.end.slice(0, 10) : e.start.slice(0, 10)
    lines.push(`DTEND;VALUE=DATE:${dateValue(addDays(end, 1))}`)
  } else if (e.end) lines.push(dt('DTEND', e.end, false))
  else lines.push('DURATION:PT1H')
  if (e.recurrenceId) lines.push(dt('RECURRENCE-ID', e.recurrenceId, e.allDay))
  lines.push(`SUMMARY:${escapeText(e.summary)}`)
  if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`)
  if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`)
  if (e.rrule && !e.recurrenceId) {
    let r = `RRULE:FREQ=${FREQ[e.rrule.freq]}`
    if (e.rrule.until) r += e.allDay ? `;UNTIL=${dateValue(e.rrule.until)}` : `;UNTIL=${utcStamp(localToUtc(e.rrule.until, '23:59'))}`
    lines.push(r)
  }
  if (e.lastModified) {
    const ms = Date.parse(e.lastModified)
    if (!isNaN(ms)) lines.push(`LAST-MODIFIED:${utcStamp(ms)}`)
  }
  lines.push('END:VEVENT')
  return lines
}

export function todoLines(t: IcalTodo): string[] {
  const lines = ['BEGIN:VTODO', `UID:${t.uid}`, `DTSTAMP:${utcStamp(Date.now())}`, `SUMMARY:${escapeText(t.summary)}`, `STATUS:${t.done ? 'COMPLETED' : 'NEEDS-ACTION'}`]
  if (t.due) lines.push(dt('DUE', t.due, t.due.length === 10))
  if (t.priority) lines.push(`PRIORITY:${t.priority}`)
  if (t.description) lines.push(`DESCRIPTION:${escapeText(t.description)}`)
  if (t.lastModified) {
    const ms = Date.parse(t.lastModified)
    if (!isNaN(ms)) lines.push(`LAST-MODIFIED:${utcStamp(ms)}`)
  }
  lines.push('END:VTODO')
  return lines
}

export function calendar(components: string[][]): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//BasaltNotes//DE', 'CALSCALE:GREGORIAN', ...components.flat(), 'END:VCALENDAR']
  return lines.map(fold).join('\r\n') + '\r\n'
}

export function etagOf(text: string): string {
  return `"${crypto.createHash('sha1').update(text).digest('hex').slice(0, 20)}"`
}

// ------------------------------------------------------------ Lesen

export interface IcalProp {
  name: string
  params: Record<string, string>
  value: string
}

function unescapeText(s: string): string {
  return s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1')
}

/** Erste Komponente VEVENT/VTODO einer iCalendar-Datei */
export function parseComponent(ics: string): { kind: 'VEVENT' | 'VTODO'; props: IcalProp[] } | null {
  const lines = ics.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)
  let kind: 'VEVENT' | 'VTODO' | null = null
  let depth = 0
  const props: IcalProp[] = []
  for (const line of lines) {
    if (!line) continue
    if (!kind) {
      const m = /^BEGIN:(VEVENT|VTODO)$/i.exec(line)
      if (m) kind = m[1].toUpperCase() as 'VEVENT' | 'VTODO'
      continue
    }
    if (/^BEGIN:/i.test(line)) {
      depth++
      continue
    }
    if (/^END:/i.test(line)) {
      if (depth === 0) break
      depth--
      continue
    }
    if (depth) continue // z. B. VALARM
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const [name, ...rawParams] = line.slice(0, idx).split(';')
    const params: Record<string, string> = {}
    for (const p of rawParams) {
      const [k, v] = p.split('=')
      if (k) params[k.toUpperCase()] = (v ?? '').replace(/^"|"$/g, '')
    }
    props.push({ name: name.toUpperCase(), params, value: line.slice(idx + 1) })
  }
  return kind ? { kind, props } : null
}

export function propText(props: IcalProp[], name: string): string | null {
  const p = props.find((x) => x.name === name)
  return p ? unescapeText(p.value) : null
}

/** DTSTART/DUE/… → gespeicherter Wert: "YYYY-MM-DD" oder Ortszeit mit Versatz */
export function propTime(props: IcalProp[], name: string): { value: string; allDay: boolean } | null {
  const p = props.find((x) => x.name === name)
  if (!p) return null
  const v = p.value.trim()
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(v)
  if (date || p.params.VALUE === 'DATE') {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(v)
    return m ? { value: `${m[1]}-${m[2]}-${m[3]}`, allDay: true } : null
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v)
  if (!m) return null
  const d = `${m[1]}-${m[2]}-${m[3]}`
  const t = `${m[4]}:${m[5]}`
  let utc: number
  if (m[7]) utc = Date.parse(`${d}T${t}:${m[6] ?? '00'}Z`)
  else if (p.params.TZID) {
    let tz = p.params.TZID
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz })
    } catch {
      tz = timeZone()
    }
    utc = localToUtc(d, t, tz)
  } else utc = localToUtc(d, t)
  return { value: utcToLocal(utc), allDay: false }
}

/** RRULE → einfache Wiederholung (nur FREQ und UNTIL; INTERVAL/BYDAY u. ä. werden nicht unterstützt) */
export function propRrule(props: IcalProp[]): { freq: 'day' | 'week' | 'month' | 'year'; until: string | null } | null {
  const p = props.find((x) => x.name === 'RRULE')
  if (!p) return null
  const parts = Object.fromEntries(p.value.split(';').map((x) => x.split('=') as [string, string]))
  const freq = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[String(parts.FREQ ?? '').toUpperCase()] as 'day' | 'week' | 'month' | 'year' | undefined
  if (!freq) return null
  let until: string | null = null
  if (parts.UNTIL) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(parts.UNTIL)
    if (m) until = `${m[1]}-${m[2]}-${m[3]}`
  }
  return { freq, until }
}

/** Zeitraum aus CalDAV time-range ("20261101T000000Z") */
export function parseUtcStamp(s: string | null | undefined): number | null {
  if (!s) return null
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(s)
  if (!m) return null
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0))
}
