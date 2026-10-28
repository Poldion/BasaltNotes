import crypto from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { NoteRecord as Note, ServerPluginContext, VaultApi as Vault } from '@basaltnotes/plugin-sdk'
import { calendarItems, calendarTypes, dateFieldOf, DONE, isLooseType, localDateTime } from './calendar.js'
import { H } from './h.js'
import { calendar, etagOf, eventLines, parseComponent, parseUtcStamp, propRrule, propText, propTime, todoLines, utcToLocal, type IcalEvent } from './ical.js'

/*
 * CalDAV (RFC 4791) – gerade so viel, wie Home Assistant (CalDAV-Integration), iOS/Android (DAVx⁵)
 * und Thunderbird brauchen. Je Notizbuch:
 *   /dav/calendars/<vault>/                 Termine (VEVENT): alle Notizen mit Datumsfeld, Typ „Termin“ bearbeitbar
 *   /dav/calendars/<vault>~aufgaben/        Aufgaben (VTODO): Notizen vom Typ „Aufgabe“
 *   /dav/calendars/<vault>~liste~<id>/      To-do-Liste (VTODO): die Checklistenpunkte einer Liste
 * Anmeldung: HTTP Basic mit beliebigem Benutzernamen und einem API-Token als Passwort (oder Bearer).
 */

declare module 'fastify' {
  interface FastifyContextConfig {
    /** @fastify/cors für diese Route aus */
    cors?: boolean
  }
}

const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ical="http://apple.com/ns/ical/"'
const ROOT = '/dav'

interface Coll {
  id: string
  vault: Vault
  kind: 'events' | 'tasks' | 'list'
  listId?: string
  name: string
  comp: 'VEVENT' | 'VTODO'
  color: string
}

interface Resource {
  name: string
  etag: string
  ics: string
  /** zugehörige Notiz (bei Listenpunkten: die Liste) */
  noteId: string
  /** Index des Listenpunkts */
  task?: number
  /** Nur lesbar (z. B. Sessions im Terminkalender) */
  readonly?: boolean
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const sha = (s: string) => crypto.createHash('sha1').update(s).digest('hex')

function davError(status: number, message: string) {
  return Object.assign(new Error(message), { davStatus: status })
}

// ------------------------------------------------------------ Anmeldung

/** Was dieser Teil vom Plugin-Kontext braucht */
type Ctx = Pick<ServerPluginContext, 'db' | 'vaults'>

function authenticate(_s: Ctx, req: FastifyRequest): boolean {
  const h = req.headers.authorization ?? ''
  let token: string | null = null
  if (h.startsWith('Bearer ')) token = h.slice(7).trim()
  else if (h.startsWith('Basic ')) {
    const raw = Buffer.from(h.slice(6), 'base64').toString('utf8')
    token = raw.slice(raw.indexOf(':') + 1)
  }
  if (!token) return false
  return H.authenticateToken(req, token)
}

function canRead(req: FastifyRequest, v: Vault): boolean {
  try {
    H.requireScope(req, 'read', v.id)
    return true
  } catch {
    return false
  }
}

function canWrite(req: FastifyRequest, v: Vault): boolean {
  try {
    H.requireScope(req, 'write', v.id)
    return true
  } catch {
    return false
  }
}

// ------------------------------------------------------------ Sammlungen

function eventTypes(v: Vault): string[] {
  return calendarTypes(v).filter((t) => t !== 'task')
}

function collections(s: Ctx, req: FastifyRequest): Coll[] {
  const out: Coll[] = []
  for (const v of s.vaults.list()) {
    if (!canRead(req, v)) continue
    const name = v.config.name
    if (eventTypes(v).length) out.push({ id: v.id, vault: v, kind: 'events', name: `${name} – Termine`, comp: 'VEVENT', color: '#4FA3E0' })
    if (v.config.types.task) out.push({ id: `${v.id}~aufgaben`, vault: v, kind: 'tasks', name: `${name} – Aufgaben`, comp: 'VTODO', color: '#F0B429' })
    if (v.config.types.list) {
      const params: any[] = [v.id]
      const rows = s.db.all<any>(`SELECT n.id, n.title FROM notes n WHERE n.vault = ? AND n.type = 'list'${H.restrictSql(H.accessOf(req, v.id), params)} ORDER BY n.title`, ...params)
      for (const r of rows) out.push({ id: `${v.id}~liste~${r.id}`, vault: v, kind: 'list', listId: r.id, name: r.title, comp: 'VTODO', color: '#5BC0BE' })
    }
  }
  return out
}

function findColl(s: Ctx, req: FastifyRequest, id: string): Coll {
  const c = collections(s, req).find((x) => x.id === id)
  if (!c) throw davError(404, 'Kalender nicht gefunden')
  return c
}

// ------------------------------------------------------------ Ressourcen

function resourceName(fm: Record<string, any>, id: string): string {
  return fm.dav_name ? String(fm.dav_name) : `${fm.ical_uid ? String(fm.ical_uid) : id}.ics`
}

function eventOf(v: Vault, row: { id: string; title: string; type: string; frontmatter: string; body?: string; updated?: string | null }): IcalEvent | null {
  const fm = H.json<Record<string, any>>(row.frontmatter, {})
  const field = dateFieldOf(v, row.type, fm)
  if (!field) return null
  const s = localDateTime(fm[field])
  if (!s) return null
  const allDay = fm.all_day === true || String(fm.all_day) === 'true' || !s.time
  const freq = FREQ[String(fm.recurrence ?? '').toLowerCase()]
  const start = allDay ? s.date : String(fm[field])
  const endRaw = field === 'start' && fm.end ? String(fm.end instanceof Date ? fm.end.toISOString() : fm.end) : null
  return {
    uid: fm.ical_uid ? String(fm.ical_uid) : row.id,
    summary: row.title,
    start,
    end: endRaw ? (allDay ? endRaw.slice(0, 10) : endRaw) : null,
    allDay,
    location: fm.location ? H.stripLink(fm.location) : null,
    rrule: freq ? { freq, until: localDateTime(fm.until)?.date ?? null } : null,
    lastModified: row.updated ?? null,
  }
}

/** UIDs der Listenpunkte: aus Notiz-ID und Text (bleibt beim Abhaken gleich) */
function listItems(note: Note): { uid: string; index: number; checked: boolean; text: string }[] {
  const seen = new Map<string, number>()
  return H.listTasks(note.body).map((t) => {
    const h = sha(t.text).slice(0, 12)
    const n = seen.get(h) ?? 0
    seen.set(h, n + 1)
    return { uid: `${note.id}-${h}${n ? `-${n}` : ''}`, index: t.index, checked: t.checked, text: t.text }
  })
}

const PRIORITY: Record<string, number> = { hoch: 1, mittel: 5, niedrig: 9 }

const FREQ: Record<string, 'day' | 'week' | 'month' | 'year'> = {
  täglich: 'day',
  daily: 'day',
  wöchentlich: 'week',
  weekly: 'week',
  monatlich: 'month',
  monthly: 'month',
  jährlich: 'year',
  yearly: 'year',
}

function resources(s: Ctx, req: FastifyRequest, c: Coll, range?: { from: number; to: number } | null, expand = false): Resource[] {
  const v = c.vault
  const access = H.accessOf(req, v.id)
  if (c.kind === 'list') {
    const note = v.readNote(c.listId!)
    if (!note || !H.restrictionAllows(access, note)) return []
    return listItems(note).map((it) => {
      const ics = calendar([todoLines({ uid: it.uid, summary: it.text, done: it.checked, lastModified: note.updated })])
      return { name: `${it.uid}.ics`, etag: etagOf(`${it.checked}:${it.text}`), ics, noteId: note.id, task: it.index }
    })
  }
  if (c.kind === 'tasks') {
    const params: any[] = [v.id]
    const rows = s.db.all<any>(`SELECT n.id, n.title, n.type, n.frontmatter, n.version, n.updated FROM notes n WHERE n.vault = ? AND n.type = 'task'${H.restrictSql(access, params)}`, ...params)
    return rows.map((r) => {
      const fm = H.json<Record<string, any>>(r.frontmatter, {})
      const due = localDateTime(fm.due)
      const ics = calendar([
        todoLines({
          uid: fm.ical_uid ? String(fm.ical_uid) : r.id,
          summary: r.title,
          done: !!fm.status && DONE.has(String(fm.status).toLowerCase()),
          due: due ? (due.time ? String(fm.due) : due.date) : null,
          priority: PRIORITY[String(fm.priority ?? '').toLowerCase()] ?? null,
          lastModified: r.updated,
        }),
      ])
      return { name: resourceName(fm, r.id), etag: `"${r.version}"`, ics, noteId: r.id }
    })
  }
  // Termine
  const types = eventTypes(v)
  const params: any[] = [v.id, ...types]
  let rows = s.db.all<any>(
    `SELECT n.id, n.title, n.type, n.frontmatter, n.version, n.updated FROM notes n WHERE n.vault = ? AND n.type IN (${types.map(() => '?').join(',')})${H.restrictSql(access, params)}`,
    ...params,
  )
  let occurrences: Map<string, { start: string; end: string | null }[]> | null = null
  if (range) {
    // Zeitraum über die Kalender-Logik (inkl. Wiederholungen), mit einem Tag Puffer für Zeitzonen
    const from = utcToLocal(range.from - 86400000).slice(0, 10)
    const to = utcToLocal(Math.min(range.to, range.from + 400 * 86400000) + 86400000).slice(0, 10)
    const items = calendarItems(s.db, v, from, to, access)
    occurrences = new Map()
    for (const it of items) {
      const list = occurrences.get(it.note_id) ?? []
      list.push({ start: it.start, end: it.end })
      occurrences.set(it.note_id, list)
    }
    rows = rows.filter((r) => occurrences!.has(r.id))
  }
  const out: Resource[] = []
  for (const r of rows) {
    const e = eventOf(v, r)
    if (!e) continue
    const fm = H.json<Record<string, any>>(r.frontmatter, {})
    let comps: string[][]
    if (expand && e.rrule && occurrences) {
      // Vom Client gewünscht: Serie in einzelne Vorkommen aufgelöst. Die Vorkommen sind Ortszeit ohne Versatz –
      // beim Schreiben wird über die Zeitzone umgerechnet, damit Sommer-/Winterzeit stimmt.
      comps = (occurrences.get(r.id) ?? []).map((o) => {
        const start = e.allDay ? o.start.slice(0, 10) : o.start
        const end = o.end ? (e.allDay ? o.end.slice(0, 10) : o.end) : null
        return eventLines({ ...e, start, end, rrule: null, recurrenceId: start })
      })
    } else comps = [eventLines(e)]
    out.push({ name: resourceName(fm, r.id), etag: `"${r.version}"`, ics: calendar(comps), noteId: r.id, readonly: r.type !== 'event' && !(isLooseType(v, r.type) && dateFieldOf(v, r.type, fm) === 'start') })
  }
  return out
}

function findResource(s: Ctx, req: FastifyRequest, c: Coll, name: string): Resource | null {
  return resources(s, req, c).find((r) => r.name === name) ?? null
}

// ------------------------------------------------------------ XML

function propstat(props: string[], status = 'HTTP/1.1 200 OK'): string {
  return `<d:propstat><d:prop>${props.join('')}</d:prop><d:status>${status}</d:status></d:propstat>`
}

function response(href: string, props: string[]): string {
  return `<d:response><d:href>${esc(href)}</d:href>${propstat(props)}</d:response>`
}

function multistatus(responses: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus ${NS}>${responses.join('')}</d:multistatus>`
}

function privileges(write: boolean): string {
  return `<d:current-user-privilege-set><d:privilege><d:read/></d:privilege>${write ? '<d:privilege><d:write/></d:privilege><d:privilege><d:write-content/></d:privilege><d:privilege><d:bind/></d:privilege><d:privilege><d:unbind/></d:privilege>' : ''}</d:current-user-privilege-set>`
}

function collProps(s: Ctx, req: FastifyRequest, c: Coll): string[] {
  const ctag = sha(resources(s, req, c).map((r) => r.name + r.etag).join('|')).slice(0, 24)
  return [
    '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>',
    `<d:displayname>${esc(c.name)}</d:displayname>`,
    `<c:supported-calendar-component-set><c:comp name="${c.comp}"/></c:supported-calendar-component-set>`,
    `<cs:getctag>${ctag}</cs:getctag>`,
    `<ical:calendar-color>${c.color}</ical:calendar-color>`,
    `<d:owner><d:href>${ROOT}/principal/</d:href></d:owner>`,
    privileges(canWrite(req, c.vault) && (c.kind !== 'events' || !!c.vault.config.types.event)),
  ]
}

function resourceProps(r: Resource, withData: boolean): string[] {
  const props = [`<d:getetag>${esc(r.etag)}</d:getetag>`, '<d:getcontenttype>text/calendar; charset=utf-8; component=' + (r.ics.includes('BEGIN:VTODO') ? 'vtodo' : 'vevent') + '</d:getcontenttype>', '<d:resourcetype/>']
  if (withData) props.push(`<c:calendar-data>${esc(r.ics)}</c:calendar-data>`)
  return props
}

const PRINCIPAL_PROPS = (s: Ctx, req: FastifyRequest) => [
  `<d:current-user-principal><d:href>${ROOT}/principal/</d:href></d:current-user-principal>`,
  `<d:principal-URL><d:href>${ROOT}/principal/</d:href></d:principal-URL>`,
  `<c:calendar-home-set><d:href>${ROOT}/calendars/</d:href></c:calendar-home-set>`,
  `<d:displayname>${esc((req as any).principal?.name ?? 'BasaltNotes')}</d:displayname>`,
  void s,
]

// ------------------------------------------------------------ Schreiben

async function writeEvent(s: Ctx, req: FastifyRequest, c: Coll, name: string, ics: string, existing: Resource | null): Promise<{ etag: string; created: boolean }> {
  const v = c.vault
  const comp = parseComponent(ics)
  if (!comp || comp.kind !== c.comp) throw davError(415, `Erwartet ${c.comp}`)
  const uid = propText(comp.props, 'UID') ?? name.replace(/\.ics$/, '')
  const summary = (propText(comp.props, 'SUMMARY') ?? '').trim() || 'Ohne Titel'

  if (c.kind === 'list') {
    const note = v.getNote(c.listId!)
    const done = (propText(comp.props, 'STATUS') ?? '').toUpperCase() === 'COMPLETED'
    const text = summary.replace(/\r?\n/g, ' ')
    const lines = note.body.split('\n')
    const items = H.listTasks(note.body)
    if (existing?.task !== undefined) {
      const t = items[existing.task]
      lines[t.line] = lines[t.line].replace(/\[([ xX])\]([ \t]+).*$/, `[${done ? 'x' : ' '}]$2${text}`)
    }
    // Neuer Punkt hinter dem letzten Listenpunkt
    const body = existing?.task !== undefined ? lines.join('\n') : H.appendTask(note.body, text, done)
    const prefix = note.raw.endsWith(note.body) ? note.raw.slice(0, note.raw.length - note.body.length) : null
    const updated = prefix !== null ? await v.replaceNote(note.id, { raw: prefix + body }, note.version) : await v.replaceNote(note.id, { body, frontmatter: note.frontmatter }, note.version)
    const now = listItems(updated).find((it) => it.text === text && it.checked === done)
    return { etag: etagOf(`${done}:${now?.text ?? text}`), created: !existing }
  }

  const fm: Record<string, any> = {}
  if (c.kind === 'tasks') {
    const due = propTime(comp.props, 'DUE')
    fm.due = due ? due.value : null
    fm.status = (propText(comp.props, 'STATUS') ?? '').toUpperCase() === 'COMPLETED' ? 'erledigt' : 'offen'
    const prio = Number(propText(comp.props, 'PRIORITY') ?? 0)
    if (prio) fm.priority = prio <= 4 ? 'hoch' : prio <= 6 ? 'mittel' : 'niedrig'
  } else {
    const start = propTime(comp.props, 'DTSTART')
    if (!start) throw davError(400, 'DTSTART fehlt')
    let end = propTime(comp.props, 'DTEND')
    if (start.allDay && end) {
      // Ende ist exklusiv → letzter Tag
      const d = new Date(`${end.value.slice(0, 10)}T00:00:00Z`)
      d.setUTCDate(d.getUTCDate() - 1)
      end = { value: d.toISOString().slice(0, 10), allDay: true }
    }
    fm.start = start.value
    fm.all_day = start.allDay ? true : null
    fm.end = end && end.value !== start.value ? end.value : null
    fm.location = propText(comp.props, 'LOCATION') || null
    const rr = propRrule(comp.props)
    fm.recurrence = rr ? { day: 'täglich', week: 'wöchentlich', month: 'monatlich', year: 'jährlich' }[rr.freq] : null
    fm.until = rr?.until ?? null
  }

  if (existing) {
    if (existing.readonly) throw davError(403, 'Dieser Eintrag ist nur lesbar (kein Termin)')
    const note = v.getNote(existing.noteId)
    const set: Record<string, any> = {}
    const remove: string[] = []
    for (const [k, val] of Object.entries(fm)) {
      if (val === null || val === undefined || val === '') {
        if (note.frontmatter[k] !== undefined) remove.push(k)
      } else set[k] = val
    }
    if (H.isAreaRestricted(req, v.id)) H.assertInArea(req, v, { campaign: note.campaign, type: note.type, path: note.path })
    let updated = await v.patchNote(note.id, { frontmatter: set, remove }, undefined)
    if (summary !== note.title) updated = (await v.renameNote(note.id, { title: summary })).note
    return { etag: `"${updated.version}"`, created: false }
  }

  // Neu anlegen
  // Ohne Termin-Typ (freier Vault): normale Notiz mit Datum im Kopf
  const type = c.kind === 'tasks' ? 'task' : v.config.types.event ? 'event' : (Object.keys(v.config.types).find((t) => isLooseType(v, t)) ?? 'event')
  if (!v.config.types[type]) throw davError(403, 'Dieses Notizbuch kennt keine Termine')
  const frontmatter: Record<string, any> = Object.fromEntries(Object.entries(fm).filter(([, x]) => x !== null && x !== undefined && x !== ''))
  frontmatter.ical_uid = uid
  if (name !== `${uid}.ics`) frontmatter.dav_name = name
  const area = H.accessOf(req, v.id)
  if (area.campaign) frontmatter.campaign = area.campaign
  if (H.isAreaRestricted(req, v.id)) {
    const folder = v.folderFor(type, area.campaign ?? null, summary)
    H.assertInArea(req, v, { campaign: area.campaign ?? null, type, path: `${folder ? folder + '/' : ''}${summary}.md` })
  }
  const description = propText(comp.props, 'DESCRIPTION')
  const note = await v.createNote({ type, title: summary, frontmatter, ...(description ? { body: `# ${summary}\n\n${description}\n` } : {}) })
  return { etag: `"${note.version}"`, created: true }
}

async function deleteResource(c: Coll, r: Resource) {
  const v = c.vault
  if (c.kind === 'list') {
    const note = v.getNote(c.listId!)
    const t = H.listTasks(note.body)[r.task!]
    const lines = note.body.split('\n')
    lines.splice(t.line, 1)
    const body = lines.join('\n')
    const prefix = note.raw.endsWith(note.body) ? note.raw.slice(0, note.raw.length - note.body.length) : null
    if (prefix !== null) await v.replaceNote(note.id, { raw: prefix + body }, note.version)
    else await v.replaceNote(note.id, { body, frontmatter: note.frontmatter }, note.version)
    return
  }
  if (r.readonly) throw davError(403, 'Dieser Eintrag ist nur lesbar')
  await v.deleteNote(r.noteId)
}

// ------------------------------------------------------------ REPORT

function parseReport(body: string) {
  const local = (name: string) => new RegExp(`<(?:[\\w-]+:)?${name}[\\s/>]`, 'i')
  const kind = local('calendar-multiget').test(body) ? 'multiget' : local('calendar-query').test(body) ? 'query' : local('sync-collection').test(body) ? 'sync' : 'other'
  const hrefs = [...body.matchAll(/<(?:[\w-]+:)?href>([^<]+)<\/(?:[\w-]+:)?href>/gi)].map((m) => decodeURIComponent(m[1].trim()))
  const tr = /<(?:[\w-]+:)?time-range([^>]*)\/?>/i.exec(body)
  const attr = (n: string) => (tr ? new RegExp(`${n}="([^"]+)"`, 'i').exec(tr[1])?.[1] : undefined)
  const from = parseUtcStamp(attr('start'))
  const to = parseUtcStamp(attr('end'))
  const comps = [...body.matchAll(/<(?:[\w-]+:)?comp-filter[^>]*name="([^"]+)"/gi)].map((m) => m[1].toUpperCase())
  const wantsData = local('calendar-data').test(body) || kind === 'multiget'
  const expand = local('expand').test(body)
  return { kind, hrefs, range: from !== null || to !== null ? { from: from ?? 0, to: to ?? Date.UTC(2100, 0, 1) } : null, comps, wantsData, expand }
}

// ------------------------------------------------------------ Routen

export function registerDav(app: FastifyInstance, s: Ctx) {
  app.addContentTypeParser(['application/xml', 'text/xml', 'text/calendar'], { parseAs: 'string' }, (_req, body, done) => done(null, body))

  const davHeaders = (reply: FastifyReply) =>
    reply.header('DAV', '1, 2, 3, calendar-access').header('Allow', 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, REPORT')

  // CalDAV-Clients fragen per OPTIONS nach Fähigkeiten – das ist keine Browser-Vorabprüfung (CORS aus)
  const config = { cors: false }
  app.all('/.well-known/caldav', { config }, async (_req, reply) => reply.redirect(`${ROOT}/`, 301))

  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    davHeaders(reply)
    if (req.method === 'OPTIONS') return reply.code(200).send()
    if (!authenticate(s, req)) {
      return reply.code(401).header('WWW-Authenticate', 'Basic realm="BasaltNotes CalDAV", charset="UTF-8"').type('text/plain; charset=utf-8').send('Anmeldung mit API-Token als Passwort erforderlich.')
    }
    const path = decodeURIComponent(req.url.split('?')[0]).replace(/\/+$/, '') || ROOT
    const rel = path.slice(ROOT.length).replace(/^\/+/, '')
    const parts = rel ? rel.split('/') : []
    const depth = String(req.headers.depth ?? '0')
    const body = typeof req.body === 'string' ? req.body : ''
    try {
      // /dav  und  /dav/principal
      if (parts.length === 0 || (parts.length === 1 && parts[0] === 'principal')) {
        if (req.method !== 'PROPFIND') return reply.code(405).send()
        const props = PRINCIPAL_PROPS(s, req).filter(Boolean) as string[]
        const type = parts.length ? '<d:resourcetype><d:principal/><d:collection/></d:resourcetype>' : '<d:resourcetype><d:collection/></d:resourcetype>'
        return reply.code(207).type('application/xml; charset=utf-8').send(multistatus([response(`${ROOT}/${parts.length ? 'principal/' : ''}`, [type, ...props])]))
      }
      if (parts[0] !== 'calendars') return reply.code(404).send()

      // /dav/calendars – Liste der Kalender
      if (parts.length === 1) {
        if (req.method !== 'PROPFIND') return reply.code(405).send()
        const out = [response(`${ROOT}/calendars/`, ['<d:resourcetype><d:collection/></d:resourcetype>', `<d:displayname>BasaltNotes</d:displayname>`, `<d:current-user-principal><d:href>${ROOT}/principal/</d:href></d:current-user-principal>`])]
        if (depth !== '0') for (const c of collections(s, req)) out.push(response(`${ROOT}/calendars/${encodeURIComponent(c.id)}/`, collProps(s, req, c)))
        return reply.code(207).type('application/xml; charset=utf-8').send(multistatus(out))
      }

      const c = findColl(s, req, parts[1])
      const base = `${ROOT}/calendars/${encodeURIComponent(c.id)}/`

      // Sammlung
      if (parts.length === 2) {
        if (req.method === 'PROPFIND') {
          const out = [response(base, collProps(s, req, c))]
          if (depth !== '0') for (const r of resources(s, req, c)) out.push(response(base + encodeURIComponent(r.name), resourceProps(r, false)))
          return reply.code(207).type('application/xml; charset=utf-8').send(multistatus(out))
        }
        if (req.method === 'REPORT') {
          const q = parseReport(body)
          if (q.kind === 'sync') return reply.code(403).type('application/xml; charset=utf-8').send(`<?xml version="1.0" encoding="utf-8"?><d:error ${NS}><d:valid-sync-token/></d:error>`)
          if (q.comps.length && !q.comps.includes(c.comp) && q.comps.every((x) => x !== 'VCALENDAR')) return reply.code(207).type('application/xml; charset=utf-8').send(multistatus([]))
          let list: Resource[]
          if (q.kind === 'multiget') {
            const all = resources(s, req, c)
            const names = q.hrefs.map((h) => h.split('/').filter(Boolean).pop() ?? '')
            const out = names.map((n) => {
              const r = all.find((x) => x.name === n)
              return r ? response(base + encodeURIComponent(r.name), resourceProps(r, true)) : `<d:response><d:href>${esc(base + n)}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`
            })
            return reply.code(207).type('application/xml; charset=utf-8').send(multistatus(out))
          }
          list = resources(s, req, c, c.kind === 'events' ? q.range : null, q.expand)
          return reply.code(207).type('application/xml; charset=utf-8').send(multistatus(list.map((r) => response(base + encodeURIComponent(r.name), resourceProps(r, q.wantsData)))))
        }
        if (req.method === 'GET' || req.method === 'HEAD') {
          // Ganzer Kalender als .ics (zum Abonnieren)
          const all = resources(s, req, c)
          const merged = all.flatMap((r) => r.ics.split('\r\n').filter((l, i, arr) => i > 3 && i < arr.length - 2))
          return reply.type('text/calendar; charset=utf-8').send(calendar([merged]))
        }
        return reply.code(405).send()
      }

      // Einzelner Eintrag
      const name = parts.slice(2).join('/')
      const r = findResource(s, req, c, name)
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (!r) return reply.code(404).send()
        return reply.type('text/calendar; charset=utf-8').header('ETag', r.etag).send(r.ics)
      }
      if (req.method === 'PROPFIND') {
        if (!r) return reply.code(404).send()
        return reply.code(207).type('application/xml; charset=utf-8').send(multistatus([response(base + encodeURIComponent(r.name), resourceProps(r, false))]))
      }
      if (req.method === 'PUT' || req.method === 'DELETE') {
        if (!canWrite(req, c.vault)) return reply.code(403).type('text/plain; charset=utf-8').send('Dieser Zugang darf nur lesen.')
        const ifMatch = req.headers['if-match']
        const ifNone = req.headers['if-none-match']
        if (ifNone === '*' && r) return reply.code(412).send()
        if (typeof ifMatch === 'string' && ifMatch !== '*' && (!r || ifMatch !== r.etag)) return reply.code(412).send()
        if (req.method === 'DELETE') {
          if (!r) return reply.code(404).send()
          await deleteResource(c, r)
          return reply.code(204).send()
        }
        const w = await writeEvent(s, req, c, name, body, r)
        return reply.code(w.created ? 201 : 204).header('ETag', w.etag).send()
      }
      return reply.code(405).send()
    } catch (e: any) {
      if (e?.davStatus) return reply.code(e.davStatus).type('text/plain; charset=utf-8').send(e.message)
      if (typeof e?.status === 'number' && e?.code) return reply.code(e.status).type('text/plain; charset=utf-8').send(e.message)
      req.log.error(e)
      return reply.code(500).type('text/plain; charset=utf-8').send('Interner Fehler')
    }
  }

  const methods = ['OPTIONS', 'GET', 'HEAD', 'PUT', 'DELETE', 'PROPFIND', 'REPORT'] as any
  app.route({ method: methods, url: ROOT, handler, config })
  app.route({ method: methods, url: `${ROOT}/*`, handler, config })
}
