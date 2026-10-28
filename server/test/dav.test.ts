import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeLlm, makeApp } from './helpers.js'

let ctx: Awaited<ReturnType<typeof makeApp>>
let basic = ''
let listId = ''
const N = '/api/v1/vaults/leben'
const api = async (method: string, url: string, body?: any) => {
  const r = await ctx.app.inject({ method: method as any, url, payload: body, headers: ctx.auth })
  return { status: r.statusCode, json: r.json() as any }
}
const dav = async (method: string, url: string, body?: string, headers: Record<string, string> = {}, auth: string | null = basic) => {
  const r = await ctx.app.inject({
    method: method as any,
    url,
    payload: body,
    headers: { ...(auth ? { authorization: auth } : {}), ...(body ? { 'content-type': body.startsWith('BEGIN:') ? 'text/calendar; charset=utf-8' : 'application/xml; charset=utf-8' } : {}), ...headers },
  })
  return { status: r.statusCode, body: r.payload, headers: r.headers }
}
const basicFor = (token: string) => `Basic ${Buffer.from(`ha:${token}`).toString('base64')}`

const ics = (comp: string, lines: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//HA//EN', `BEGIN:${comp}`, ...lines, `END:${comp}`, 'END:VCALENDAR', ''].join('\r\n')
const QUERY = (comp: string, start: string, end: string, expand = false) => `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data>${expand ? `<C:expand start="${start}" end="${end}"/>` : ''}</C:calendar-data></D:prop>
  <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="${comp}"><C:time-range start="${start}" end="${end}"/></C:comp-filter></C:comp-filter></C:filter>
</C:calendar-query>`
const TODOS = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data/></D:prop>
<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VTODO"/></C:comp-filter></C:filter></C:calendar-query>`
const PROPFIND = `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:displayname/></D:prop></D:propfind>`

beforeAll(async () => {
  ctx = await makeApp(new FakeLlm([]))
  await api('POST', '/api/v1/vaults', { name: 'Leben', id: 'leben', preset: 'notes' })
  await api('POST', `${N}/notes`, { type: 'event', title: 'Zahnarzt', frontmatter: { start: '2026-11-03T09:30:00+01:00', end: '2026-11-03T10:15:00+01:00', location: 'Praxis' } })
  await api('POST', `${N}/notes`, { type: 'event', title: 'Sport', frontmatter: { start: '2026-11-02T18:00:00+01:00', recurrence: 'wöchentlich', until: '2026-11-23' } })
  await api('POST', `${N}/notes`, { type: 'event', title: 'Urlaub', frontmatter: { start: '2026-12-20', end: '2026-12-24', all_day: true } })
  await api('POST', `${N}/notes`, { type: 'task', title: 'Steuer', frontmatter: { due: '2026-11-10', status: 'offen', priority: 'hoch' } })
  listId = (await api('POST', `${N}/notes`, { type: 'list', title: 'Einkauf', body: '# Einkauf\n\n- [ ] Milch\n- [x] Brot\n\nNotiz unten.\n' })).json.id
  await api('POST', '/api/v1/vaults/dnd/notes', { type: 'session', title: 'Session 4', frontmatter: { date: '2026-11-07T19:00:00+01:00' } })
  const tok = (await api('POST', '/api/v1/tokens', { name: 'Home Assistant', grants: [{ vault: 'leben', access: 'write' }, { vault: 'dnd', access: 'write' }] })).json.token
  basic = basicFor(tok)
})
afterAll(async () => ctx?.cleanup())

describe('CalDAV: Anmeldung und Suche nach Kalendern', () => {
  it('verlangt Anmeldung mit Token als Passwort', async () => {
    const r = await dav('PROPFIND', '/dav/', PROPFIND, { depth: '0' }, null)
    expect(r.status).toBe(401)
    expect(r.headers['www-authenticate']).toMatch(/Basic/)
    expect((await dav('PROPFIND', '/dav/', PROPFIND, { depth: '0' }, basicFor('falsch'))).status).toBe(401)
    expect((await dav('OPTIONS', '/dav/', undefined, {}, null)).headers.dav).toMatch(/calendar-access/)
    const wk = await dav('GET', '/.well-known/caldav', undefined, {}, null)
    expect(wk.status).toBe(301)
    expect(wk.headers.location).toBe('/dav/')
  })

  it('findet Principal, Kalender-Ordner und Kalender', async () => {
    expect((await dav('PROPFIND', '/dav/', PROPFIND, { depth: '0' })).body).toMatch(/current-user-principal><d:href>\/dav\/principal\//)
    expect((await dav('PROPFIND', '/dav/principal/', PROPFIND, { depth: '0' })).body).toMatch(/calendar-home-set><d:href>\/dav\/calendars\//)
    const r = await dav('PROPFIND', '/dav/calendars/', PROPFIND, { depth: '1' })
    expect(r.status).toBe(207)
    expect(r.body).toContain('<d:displayname>Leben – Termine</d:displayname>')
    expect(r.body).toContain('<d:displayname>Leben – Aufgaben</d:displayname>')
    expect(r.body).toContain('<d:displayname>Einkauf</d:displayname>')
    expect(r.body).toContain(`/dav/calendars/leben~liste~${listId}/`)
    expect(r.body).toContain('<c:comp name="VTODO"/>')
    expect(r.body).toContain('<d:displayname>DnD – Termine</d:displayname>')
  })
})

describe('CalDAV: Termine', () => {
  it('liefert Termine im Zeitraum, Serien mit RRULE oder aufgelöst', async () => {
    const r = await dav('REPORT', '/dav/calendars/leben/', QUERY('VEVENT', '20261101T000000Z', '20261201T000000Z'), { depth: '1' })
    expect(r.status).toBe(207)
    expect(r.body).toContain('SUMMARY:Zahnarzt')
    expect(r.body).toContain('DTSTART:20261103T083000Z') // 09:30 Ortszeit (Winterzeit)
    expect(r.body).toContain('LOCATION:Praxis')
    expect(r.body).toContain('RRULE:FREQ=WEEKLY;UNTIL=')
    expect(r.body).not.toContain('Urlaub')
    const ex = await dav('REPORT', '/dav/calendars/leben/', QUERY('VEVENT', '20261101T000000Z', '20261201T000000Z', true), { depth: '1' })
    expect(ex.body.match(/RECURRENCE-ID/g)).toHaveLength(4)
    expect(ex.body).not.toContain('RRULE')
    const dec = await dav('REPORT', '/dav/calendars/leben/', QUERY('VEVENT', '20261201T000000Z', '20270101T000000Z'), { depth: '1' })
    expect(dec.body).toContain('DTSTART;VALUE=DATE:20261220')
    expect(dec.body).toContain('DTEND;VALUE=DATE:20261225') // exklusiv
  })

  it('legt Termine an, ändert und löscht sie', async () => {
    const event = ics('VEVENT', ['UID:ha-123', 'DTSTAMP:20261028T100000Z', 'DTSTART:20261115T170000Z', 'DTEND:20261115T180000Z', 'SUMMARY:Elternabend', 'LOCATION:Schule'])
    const put = await dav('PUT', '/dav/calendars/leben/ha-123.ics', event, { 'if-none-match': '*' })
    expect(put.status).toBe(201)
    const note = (await api('GET', `${N}/notes/by-title?title=Elternabend`)).json
    expect(note.frontmatter).toMatchObject({ start: '2026-11-15T18:00:00+01:00', end: '2026-11-15T19:00:00+01:00', location: 'Schule', ical_uid: 'ha-123' })
    const get = await dav('GET', '/dav/calendars/leben/ha-123.ics')
    expect(get.body).toContain('UID:ha-123')
    expect(get.headers.etag).toBe(put.headers.etag)
    // Ändern (andere Zeit, neuer Titel, Sommerzeit-Datum mit TZID)
    const changed = ics('VEVENT', ['UID:ha-123', 'DTSTART;TZID=Europe/Berlin:20270610T190000', 'DTEND;TZID=Europe/Berlin:20270610T200000', 'SUMMARY:Elternabend Klasse 3'])
    expect((await dav('PUT', '/dav/calendars/leben/ha-123.ics', changed, { 'if-match': 'falsch' })).status).toBe(412)
    expect((await dav('PUT', '/dav/calendars/leben/ha-123.ics', changed, { 'if-match': String(get.headers.etag) })).status).toBe(204)
    const n2 = (await api('GET', `${N}/notes/${note.id}`)).json
    expect(n2.title).toBe('Elternabend Klasse 3')
    expect(n2.frontmatter.start).toBe('2027-06-10T19:00:00+02:00')
    expect(n2.frontmatter.location).toBeUndefined()
    expect((await dav('DELETE', '/dav/calendars/leben/ha-123.ics')).status).toBe(204)
    expect((await api('GET', `${N}/notes/${note.id}`)).status).toBe(404)
  })

  it('Sessions sind nur lesbar', async () => {
    const r = await dav('REPORT', '/dav/calendars/dnd/', QUERY('VEVENT', '20261101T000000Z', '20261201T000000Z'), { depth: '1' })
    expect(r.body).toContain('SUMMARY:Session 4')
    const name = /\/dav\/calendars\/dnd\/([^<]+\.ics)/.exec(r.body)![1]
    expect((await dav('PUT', `/dav/calendars/dnd/${name}`, ics('VEVENT', ['UID:x', 'DTSTART:20261108T180000Z', 'SUMMARY:Hack']))).status).toBe(403)
  })
})

describe('CalDAV: Aufgaben und Listen (To-dos in Home Assistant)', () => {
  it('Aufgaben-Notizen als VTODO, abhaken setzt den Status', async () => {
    const r = await dav('REPORT', '/dav/calendars/leben~aufgaben/', TODOS, { depth: '1' })
    expect(r.body).toContain('SUMMARY:Steuer')
    expect(r.body).toContain('DUE;VALUE=DATE:20261110')
    expect(r.body).toContain('PRIORITY:1')
    const name = /\/dav\/calendars\/leben~aufgaben\/([^<]+\.ics)/.exec(r.body)![1]
    const done = ics('VTODO', [`UID:${name.replace('.ics', '')}`, 'SUMMARY:Steuer', 'STATUS:COMPLETED', 'DUE;VALUE=DATE:20261110'])
    expect((await dav('PUT', `/dav/calendars/leben~aufgaben/${name}`, done)).status).toBe(204)
    expect((await api('GET', `${N}/notes/by-title?title=Steuer`)).json.frontmatter.status).toBe('erledigt')
    expect((await dav('PUT', '/dav/calendars/leben~aufgaben/neu-1.ics', ics('VTODO', ['UID:neu-1', 'SUMMARY:Reifen wechseln', 'STATUS:NEEDS-ACTION']))).status).toBe(201)
    expect((await api('GET', `${N}/notes/by-title?title=Reifen wechseln`)).json.type).toBe('task')
  })

  it('Listenpunkte als VTODO: abhaken, hinzufügen, löschen – im Markdown', async () => {
    const coll = `/dav/calendars/leben~liste~${listId}/`
    const r = await dav('REPORT', coll, TODOS, { depth: '1' })
    expect(r.body).toContain('SUMMARY:Milch')
    expect(r.body).toMatch(/SUMMARY:Brot\r?\nSTATUS:COMPLETED|STATUS:COMPLETED/)
    const milch = new RegExp(`${coll.replace(/[~]/g, '~')}([^<]+\\.ics)</d:href>(?:(?!</d:response>).)*SUMMARY:Milch`, 's').exec(r.body)![1]
    expect((await dav('PUT', coll + milch, ics('VTODO', [`UID:${milch.replace('.ics', '')}`, 'SUMMARY:Milch', 'STATUS:COMPLETED']))).status).toBe(204)
    expect((await dav('PUT', coll + 'ha-neu.ics', ics('VTODO', ['UID:ha-neu', 'SUMMARY:Eier', 'STATUS:NEEDS-ACTION']))).status).toBe(201)
    let body = (await api('GET', `${N}/notes/${listId}`)).json.body
    expect(body).toBe('# Einkauf\n\n- [x] Milch\n- [x] Brot\n- [ ] Eier\n\nNotiz unten.\n')
    // UID bleibt beim Abhaken gleich → Löschen über dieselbe Adresse
    expect((await dav('DELETE', coll + milch)).status).toBe(204)
    body = (await api('GET', `${N}/notes/${listId}`)).json.body
    expect(body).toBe('# Einkauf\n\n- [x] Brot\n- [ ] Eier\n\nNotiz unten.\n')
  })
})

describe('CalDAV: Rechte', () => {
  it('nur-lesen darf nichts ändern, Bereich begrenzt die Kalender', async () => {
    const ro = (await api('POST', '/api/v1/tokens', { name: 'nur lesen', grants: [{ vault: 'leben', access: 'read', types: ['event'] }] })).json.token
    const h = basicFor(ro)
    const list = await dav('PROPFIND', '/dav/calendars/', PROPFIND, { depth: '1' }, h)
    expect(list.body).toContain('Leben – Termine')
    expect(list.body).not.toContain('DnD')
    expect(list.body).not.toContain('Einkauf') // Listen gehören nicht zum Bereich
    expect((await dav('PUT', '/dav/calendars/leben/x.ics', ics('VEVENT', ['UID:x', 'DTSTART:20261108T180000Z', 'SUMMARY:X']), {}, h)).status).toBe(403)
    expect((await dav('REPORT', '/dav/calendars/dnd/', TODOS, { depth: '1' }, h)).status).toBe(404)
  })
})
