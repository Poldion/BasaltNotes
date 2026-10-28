import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeLlm, makeApp } from './helpers.js'

let ctx: Awaited<ReturnType<typeof makeApp>>
const V = '/api/v1/vaults/dnd'

beforeAll(async () => {
  ctx = await makeApp(new FakeLlm([]))
})
afterAll(async () => ctx?.cleanup())

async function req(method: string, url: string, body?: any, headers: Record<string, string> = {}) {
  const res = await ctx.app.inject({ method: method as any, url, payload: body, headers: { ...ctx.auth, ...headers } })
  let json: any = null
  try {
    json = res.json()
  } catch {
    json = null
  }
  return { status: res.statusCode, json, text: res.body, headers: res.headers }
}

describe('System', () => {
  it('health ohne Anmeldung', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json().index.vaults.map((v: any) => v.id).sort()).toEqual(['dnd', 'notizen'])
  })

  it('ohne Token 401 im Fehlerformat', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/vaults' })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('unauthorized')
  })

  it('openapi.json', async () => {
    const r = await req('GET', '/api/v1/openapi.json')
    expect(r.status).toBe(200)
    expect(Object.keys(r.json.paths)).toContain('/api/v1/vaults/{vault}/notes/{id}')
  })

  it('Scopes werden geprüft', async () => {
    const t = ctx.services.auth.createToken({ name: 'whisper', vaults: ['dnd'], scopes: ['inbox', 'read'] })
    const h = { authorization: `Bearer ${t.token}` }
    expect((await ctx.app.inject({ method: 'GET', url: `${V}/notes`, headers: h })).statusCode).toBe(200)
    expect((await ctx.app.inject({ method: 'POST', url: `${V}/notes`, headers: h, payload: { title: 'X' } })).statusCode).toBe(403)
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/vaults/notizen/notes`, headers: h })).statusCode).toBe(403)
  })

  it('Login mit Session-Cookie und CSRF', async () => {
    const login = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'testpasswort123' } })
    expect(login.statusCode).toBe(200)
    const cookie = login.cookies.find((c) => c.name === 'basalt_session')!
    const csrf = login.json().csrf
    const noCsrf = await ctx.app.inject({ method: 'POST', url: `${V}/notes`, cookies: { basalt_session: cookie.value }, payload: { title: 'Ohne CSRF' } })
    expect(noCsrf.statusCode).toBe(403)
    const ok = await ctx.app.inject({ method: 'POST', url: `${V}/notes`, cookies: { basalt_session: cookie.value }, headers: { 'x-csrf-token': csrf }, payload: { title: 'Mit CSRF' } })
    expect(ok.statusCode).toBe(201)
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'falsch' } })
    expect(bad.statusCode).toBe(401)
  })
})

describe('Notizen', () => {
  let zylia: any
  let session: any

  it('anlegen aus Vorlage im Typ-Ordner', async () => {
    const r = await req('POST', `${V}/notes`, { type: 'npc', title: 'Zylia', frontmatter: { campaign: 'Fluch des Strahd', aliases: ['Cydia'], attitude: 'freundlich' } })
    expect(r.status).toBe(201)
    zylia = r.json
    expect(zylia.path).toBe('Fluch des Strahd/NPCs/Zylia.md')
    expect(zylia.id).toMatch(/^[0-9A-Z]{26}$/)
    expect(zylia.body).toContain('## Aus den Sessions')
    expect(r.headers.etag).toBe(`"${zylia.version}"`)
    const file = fs.readFileSync(path.join(ctx.dataDir, 'vaults/dnd', zylia.path), 'utf8')
    expect(file).toContain(`id: ${zylia.id}`)
  })

  it('Links über Alias auflösen, Backlinks mit Kontext', async () => {
    const r = await req('POST', `${V}/notes`, { type: 'session', title: '2026-10-11 Session 1', frontmatter: { campaign: 'Fluch des Strahd' }, body: '# Session 1\n\nDie Gruppe trifft [[Cydia]] und [[Barovia]].\n' })
    session = r.json
    const links = await req('GET', `${V}/notes/${session.id}/links`)
    expect(links.json.items.find((l: any) => l.target === 'Cydia').target_id).toBe(zylia.id)
    expect(links.json.items.find((l: any) => l.target === 'Barovia').resolved).toBe(false)
    const bl = await req('GET', `${V}/notes/${zylia.id}/backlinks`)
    expect(bl.json.items).toHaveLength(1)
    expect(bl.json.items[0].context).toContain('[[Cydia]]')
  })

  it('by-title findet über Alias, by-path über Pfad', async () => {
    expect((await req('GET', `${V}/notes/by-title?title=cydia`)).json.id).toBe(zylia.id)
    expect((await req('GET', `${V}/notes/by-path?path=${encodeURIComponent(zylia.path)}`)).json.id).toBe(zylia.id)
  })

  it('PUT braucht If-Match, falsche Version → 409 mit aktuellem Stand', async () => {
    const cur = (await req('GET', `${V}/notes/${zylia.id}`)).json
    const noHeader = await req('PUT', `${V}/notes/${zylia.id}`, { raw: cur.raw })
    expect(noHeader.status).toBe(400)
    const ok = await req('PUT', `${V}/notes/${zylia.id}`, { raw: cur.raw.replace('## Beschreibung', '## Beschreibung\nKarawanenführerin.') }, { 'if-match': `"${cur.version}"` })
    expect(ok.status).toBe(200)
    expect(ok.json.body).toContain('Karawanenführerin.')
    await ctx.services.vaults.get('dnd').flushCommit()
    const conflict = await req('PUT', `${V}/notes/${zylia.id}`, { raw: cur.raw }, { 'if-match': cur.version })
    expect(conflict.status).toBe(409)
    expect(conflict.json.error.code).toBe('version_conflict')
    expect(conflict.json.error.details.current_version).toBe(ok.json.version)
  })

  it('PATCH führt Frontmatter zusammen und hängt unter Überschrift an', async () => {
    const r = await req('PATCH', `${V}/notes/${zylia.id}`, { frontmatter: { status: 'lebendig' }, append: { text: '- Mag Äpfel', heading: 'Beschreibung' } })
    expect(r.json.frontmatter.status).toBe('lebendig')
    expect(r.json.frontmatter.attitude).toBe('freundlich')
    expect(r.json.body).toMatch(/## Beschreibung\nKarawanenführerin\.\n- Mag Äpfel/)
  })

  it('Blöcke: setzen, ersetzen, Text außerhalb unverändert, ohne If-Match', async () => {
    const before = (await req('GET', `${V}/notes/${zylia.id}`)).json.body
    await req('PUT', `${V}/notes/${zylia.id}/blocks/${encodeURIComponent('whispernotes:job:ab12')}`, { content: '- eins', heading: 'Aus den Sessions', source_note: session.id })
    const r = await req('PUT', `${V}/notes/${zylia.id}/blocks/${encodeURIComponent('whispernotes:job:ab12')}`, { content: '- zwei', heading: 'Aus den Sessions', source_note: session.id })
    expect(r.json.blocks).toHaveLength(1)
    expect(r.json.blocks[0].source_note).toBe('[[2026-10-11 Session 1]]')
    expect(r.json.body).toContain('- zwei')
    expect(r.json.body).not.toContain('- eins')
    const del = await req('DELETE', `${V}/notes/${zylia.id}/blocks/${encodeURIComponent('whispernotes:job:ab12')}`)
    expect(del.status).toBe(200)
    const after = (await req('GET', `${V}/notes/${zylia.id}`)).json.body
    expect(after).toBe(before)
  })

  it('Umbenennen passt alle Links an, ID bleibt', async () => {
    await req('POST', `${V}/notes`, { type: 'location', title: 'Barovia', frontmatter: { campaign: 'Fluch des Strahd' } })
    const other = await req('POST', `${V}/notes`, { type: 'note', title: 'Notiz', body: 'Siehe [[Zylia#Beschreibung|Z]] und [[Fluch des Strahd/NPCs/Zylia]].\n' })
    const r = await req('POST', `${V}/notes/${zylia.id}/rename`, { title: 'Zylia die Weise' })
    expect(r.json.id).toBe(zylia.id)
    expect(r.json.path).toBe('Fluch des Strahd/NPCs/Zylia die Weise.md')
    const o = (await req('GET', `${V}/notes/${other.json.id}`)).json
    expect(o.body).toBe('Siehe [[Zylia die Weise#Beschreibung|Z]] und [[Zylia die Weise]].\n')
    // Alias-Link bleibt (löst weiter über Alias auf)
    expect((await req('GET', `${V}/notes/${session.id}`)).json.body).toContain('[[Cydia]]')
    expect(fs.existsSync(path.join(ctx.dataDir, 'vaults/dnd/Fluch des Strahd/NPCs/Zylia.md'))).toBe(false)
  })

  it('Suche mit Ausschnitten und Filter', async () => {
    const r = await req('GET', `${V}/search?q=Karawan&type=npc`)
    expect(r.json.items[0].id).toBe(zylia.id)
    expect(r.json.items[0].highlights[0]).toContain('<mark>')
    const none = await req('GET', `${V}/search?q=Karawan&type=location`)
    expect(none.json.items).toHaveLength(0)
  })

  it('Abfrage (Dataview-ähnlich)', async () => {
    const r = await req('POST', `${V}/query`, {
      where: [
        { field: 'type', op: '=', value: 'npc' },
        { field: 'campaign', op: '=', value: 'Fluch des Strahd' },
        { field: 'attitude', op: 'in', value: ['freundlich', 'neutral'] },
      ],
      sort: [{ field: 'updated', dir: 'desc' }],
      select: ['title', 'attitude', 'status'],
    })
    expect(r.json.items).toEqual([{ id: zylia.id, title: 'Zylia die Weise', attitude: 'freundlich', status: 'lebendig' }])
  })

  it('names + resolve', async () => {
    const n = await req('GET', `${V}/names?campaign=${encodeURIComponent('Fluch des Strahd')}&types=npc,location`)
    expect(n.json.glossary).toEqual(expect.arrayContaining(['Zylia die Weise', 'Cydia', 'Barovia']))
    const r = await req('GET', `${V}/resolve?name=Zyliya&type=npc`)
    expect(r.json.items[0].id).toBe(zylia.id)
    expect(r.json.items[0].score).toBeGreaterThan(0.6)
  })

  it('HTML ist bereinigt und nutzt link_base', async () => {
    const n = await req('POST', `${V}/notes`, { title: 'HTML', body: 'Hallo [[Barovia]] <script>alert(1)</script> [[Gibtsnicht]]\n\n- [x] erledigt\n' })
    const r = await req('GET', `${V}/notes/${n.json.id}/html?link_base=${encodeURIComponent('/wiki/{vault}/{id}')}`)
    expect(r.text).not.toContain('<script>')
    expect(r.text).toMatch(/<a class="internal-link" href="\/wiki\/dnd\/[0-9A-Z]+" data-note-id="[0-9A-Z]+" data-type="location">Barovia<\/a>/)
    expect(r.text).toContain('class="internal-link unresolved"')
    expect(r.text).toContain('type="checkbox"')
  })

  it('Idempotency-Key liefert dasselbe Ergebnis', async () => {
    const a = await req('POST', `${V}/notes`, { title: 'Idem' }, { 'idempotency-key': 'k1' })
    const b = await req('POST', `${V}/notes`, { title: 'Idem' }, { 'idempotency-key': 'k1' })
    expect(b.json.id).toBe(a.json.id)
    expect(b.headers['idempotent-replayed']).toBe('true')
  })

  it('Verlauf aus git, Diff und Wiederherstellen', async () => {
    await ctx.services.vaults.get('dnd').flushCommit()
    const h = await req('GET', `${V}/notes/${zylia.id}/history`)
    expect(h.json.items.length).toBeGreaterThanOrEqual(2)
    // Version nach dem PUT, aber vor dem PATCH suchen (unabhängig davon, wie Speichervorgänge gebündelt wurden)
    let target: string | null = null
    for (const c of h.json.items) {
      const v = await req('GET', `${V}/notes/${zylia.id}/history/${c.rev}`)
      if (v.json.content.includes('Karawanenführerin.') && !v.json.content.includes('Mag Äpfel')) {
        target = c.rev
        break
      }
    }
    expect(target).not.toBeNull()
    const d = await req('GET', `${V}/notes/${zylia.id}/history/${target}?diff=1`)
    expect(d.json.diff).toContain('+- Mag Äpfel')
    const r = await req('POST', `${V}/notes/${zylia.id}/restore`, { rev: target })
    expect(r.json.body).not.toContain('Mag Äpfel')
    expect(r.json.body).toContain('Karawanenführerin.')
    expect(r.json.id).toBe(zylia.id)
  })

  it('Papierkorb', async () => {
    const n = await req('POST', `${V}/notes`, { title: 'Weg damit' })
    await req('DELETE', `${V}/notes/${n.json.id}`)
    expect((await req('GET', `${V}/notes/${n.json.id}`)).status).toBe(404)
    const t = await req('GET', `${V}/trash`)
    const item = t.json.items.find((i: any) => i.title === 'Weg damit')
    const back = await req('POST', `${V}/trash/restore`, { path: item.path })
    expect(back.json.id).toBe(n.json.id)
  })

  it('Datei ohne ID von außen wird indiziert und bekommt eine ID', async () => {
    const v = ctx.services.vaults.get('dnd')
    fs.writeFileSync(path.join(v.dir, 'Extern.md'), '# Extern\n\nVon Obsidian [[Barovia]]\n')
    await v.indexFile('Extern.md')
    const r = await req('GET', `${V}/notes/by-path?path=Extern.md`)
    expect(r.json.id).toMatch(/^[0-9A-Z]{26}$/)
    expect(fs.readFileSync(path.join(v.dir, 'Extern.md'), 'utf8')).toMatch(/^---\nid: /)
  })

  it('Spieler-Sicht filtert DM-Inhalte', async () => {
    const n = await req('POST', `${V}/notes`, { type: 'npc', title: 'Strahd', frontmatter: { campaign: 'Fluch des Strahd', visibility: 'players' } })
    await req('PUT', `${V}/notes/${n.json.id}/blocks/geheim`, { content: 'Ist ein Vampir', visibility: 'dm' })
    await req('PUT', `${V}/notes/${n.json.id}/blocks/offen`, { content: 'Wohnt im Schloss' })
    const p = await req('GET', `${V}/notes/${n.json.id}?visibility=players`)
    expect(p.json.body).toContain('Wohnt im Schloss')
    expect(p.json.body).not.toContain('Vampir')
    expect(p.json.raw).toBeUndefined()
    const tok = ctx.services.auth.createToken({ name: 'spieler', vaults: ['dnd'], scopes: ['read'], visibility: 'players' })
    const forced = await ctx.app.inject({ method: 'GET', url: `${V}/notes/${n.json.id}/html`, headers: { authorization: `Bearer ${tok.token}` } })
    expect(forced.body).not.toContain('Vampir')
    const hidden = await ctx.app.inject({ method: 'GET', url: `${V}/notes/${zylia.id}`, headers: { authorization: `Bearer ${tok.token}` } })
    expect(hidden.statusCode).toBe(404)
  })
})

describe('Benutzerverwaltung', () => {
  async function loginAs(username: string, password: string) {
    const r = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } })
    if (r.statusCode !== 200) return { status: r.statusCode, error: r.json().error }
    const cookie = r.cookies.find((c) => c.name === 'basalt_session')!.value
    return { status: 200, cookie, csrf: r.json().csrf as string, user: r.json().user }
  }
  const as = (s: { cookie?: string; csrf?: string }) => (method: string, url: string, payload?: any) =>
    ctx.app.inject({ method: method as any, url, payload, cookies: { basalt_session: s.cookie! }, headers: s.csrf ? { 'x-csrf-token': s.csrf } : {} })

  it('Admin legt Benutzer mit Rollen an', async () => {
    const ed = await req('POST', '/api/v1/users', { username: 'mara', password: 'geheim-12345', role: 'editor', vaults: ['dnd'], display_name: 'Mara' })
    expect(ed.status).toBe(201)
    expect(ed.json.has_password).toBe(true)
    expect(ed.json.password_hash).toBeUndefined()
    const pl = await req('POST', '/api/v1/users', { username: 'spieler', password: 'spieler-12345', role: 'player', vaults: ['dnd'], campaign: 'Fluch des Strahd' })
    expect(pl.status).toBe(201)
    const dup = await req('POST', '/api/v1/users', { username: 'MARA', password: 'geheim-12345', role: 'viewer' })
    expect(dup.status).toBe(409)
    const short = await req('POST', '/api/v1/users', { username: 'kurz', password: '123', role: 'viewer' })
    expect(short.status).toBe(400)
    const list = await req('GET', '/api/v1/users')
    expect(list.json.items.map((u: any) => u.username)).toEqual(expect.arrayContaining(['admin', 'mara', 'spieler']))
  })

  it('Editor darf schreiben, aber keine Benutzer verwalten und nur seine Vaults sehen', async () => {
    const s = await loginAs('mara', 'geheim-12345')
    expect(s.status).toBe(200)
    const call = as(s)
    expect((await call('GET', '/api/v1/auth/me')).json()).toMatchObject({ role: 'editor', display_name: 'Mara' })
    expect((await call('POST', `${V}/notes`, { title: 'Von Mara' })).statusCode).toBe(201)
    expect((await call('GET', '/api/v1/users')).statusCode).toBe(403)
    expect((await call('GET', '/api/v1/vaults/notizen/notes')).statusCode).toBe(403)
    expect((await call('GET', '/api/v1/vaults')).json().items.map((v: any) => v.id)).toEqual(['dnd'])
  })

  it('Spieler sieht nur Spieler-Inhalte und darf nichts ändern', async () => {
    const s = await loginAs('spieler', 'spieler-12345')
    const call = as(s)
    const notes = (await call('GET', `${V}/notes?limit=500`)).json().items
    expect(notes.length).toBeGreaterThan(0)
    expect(notes.every((n: any) => n.visibility === 'players')).toBe(true)
    expect((await call('POST', `${V}/notes`, { title: 'Nein' })).statusCode).toBe(403)
  })

  it('Sperren beendet Sitzungen und verhindert Anmeldung', async () => {
    const s = await loginAs('mara', 'geheim-12345')
    const id = (await req('GET', '/api/v1/users')).json.items.find((u: any) => u.username === 'mara').id
    expect((await req('PATCH', `/api/v1/users/${id}`, { disabled: true })).status).toBe(200)
    expect((await as(s)('GET', '/api/v1/auth/me')).statusCode).toBe(401)
    expect((await loginAs('mara', 'geheim-12345')).status).toBe(401)
    await req('PATCH', `/api/v1/users/${id}`, { disabled: false, password: 'neues-passwort-1' })
    expect((await loginAs('mara', 'neues-passwort-1')).status).toBe(200)
  })

  it('Eigenes Passwort ändern', async () => {
    const s = await loginAs('mara', 'neues-passwort-1')
    expect((await as(s)('POST', '/api/v1/auth/password', { current: 'falsch-falsch', new: 'x-neu-12345' })).statusCode).toBe(403)
    expect((await as(s)('POST', '/api/v1/auth/password', { current: 'neues-passwort-1', new: 'x-neu-12345' })).statusCode).toBe(200)
    expect((await loginAs('mara', 'x-neu-12345')).status).toBe(200)
  })

  it('Der letzte Admin bleibt erhalten', async () => {
    const admin = (await req('GET', '/api/v1/users')).json.items.find((u: any) => u.username === 'admin')
    expect((await req('DELETE', `/api/v1/users/${admin.id}`)).status).toBe(409)
    expect((await req('PATCH', `/api/v1/users/${admin.id}`, { role: 'viewer' })).status).toBe(409)
  })
})

describe('Spieler-Sperren', () => {
  it('Spieler-Token sieht weder Eingang noch Vorschläge noch Läufe', async () => {
    const t = ctx.services.auth.createToken({ name: 'p', vaults: ['dnd'], scopes: ['read'], visibility: 'players' })
    for (const u of ['inbox', 'proposals', 'runs']) {
      const r = await ctx.app.inject({ method: 'GET', url: `${V}/${u}`, headers: { authorization: `Bearer ${t.token}` } })
      expect(r.statusCode).toBe(403)
    }
  })
})

describe('Spieler-Sicht: DM-Bereiche bleiben verborgen', () => {
  it('Suche, Links, Backlinks und Graph verraten keine DM-Bereiche', async () => {
    const tok = ctx.services.auth.createToken({ name: 'spieler-dm-test', vaults: ['dnd'], scopes: ['read'], visibility: 'players' })
    const P = (url: string) => ctx.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${tok.token}` } }).then((r) => r.json())
    const target = await req('POST', `${V}/notes`, { type: 'npc', title: 'Madam Eva', frontmatter: { visibility: 'players' } })
    const host = await req('POST', `${V}/notes`, { type: 'note', title: 'Öffentliche Fakten', frontmatter: { visibility: 'players' }, body: 'Die Karten liegen bereit.\n' })
    await req('PUT', `${V}/notes/${host.json.id}/blocks/geheim-dm`, { content: 'Halbschwester von [[Madam Eva]] ist Vampirjägerin', visibility: 'dm' })

    // DM findet es, Spieler nicht – auch nicht als Ausschnitt
    expect((await req('GET', `${V}/search?q=Vampirj%C3%A4gerin`)).json.items.map((i: any) => i.id)).toContain(host.json.id)
    expect((await P(`${V}/search?q=Vampirj%C3%A4gerin`)).items).toHaveLength(0)
    expect((await P(`${V}/search?q=Karten`)).items[0].highlights.join(' ')).not.toContain('Vampir')
    // Query mit Volltext ebenso
    const q = await ctx.app.inject({ method: 'POST', url: `${V}/query`, payload: { q: 'Vampirjägerin' }, headers: { authorization: `Bearer ${tok.token}` } })
    expect(q.json().items).toHaveLength(0)
    // Link im DM-Bereich: kein Backlink, kein ausgehender Link, keine Kante
    expect((await req('GET', `${V}/notes/${target.json.id}/backlinks`)).json.items.map((b: any) => b.source_id)).toContain(host.json.id)
    expect((await P(`${V}/notes/${target.json.id}/backlinks`)).items).toHaveLength(0)
    expect((await P(`${V}/notes/${host.json.id}`)).links).toHaveLength(0)
    const graph = await P(`${V}/graph`)
    expect(graph.edges.some((e: any) => e.source === host.json.id && e.target === target.json.id)).toBe(false)
  })
})
