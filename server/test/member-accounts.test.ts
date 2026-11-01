import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeLlm, makeApp } from './helpers.js'

let ctx: Awaited<ReturnType<typeof makeApp>>
const A = '/api/v1'
const req = async (method: string, url: string, body?: any, headers: Record<string, string> = ctx.auth) => {
  const r = await ctx.app.inject({ method: method as any, url, payload: body, headers })
  return { status: r.statusCode, json: r.json() as any }
}
const login = async (username: string, password: string) => {
  const r = await ctx.app.inject({ method: 'POST', url: `${A}/auth/login`, payload: { username, password } })
  expect(r.statusCode).toBe(200)
  const cookie = r.cookies.map((c) => `${c.name}=${c.value}`).join('; ')
  const me = (await ctx.app.inject({ method: 'GET', url: `${A}/auth/me`, headers: { cookie } })).json() as any
  return { me, h: { cookie, 'x-csrf-token': me.csrf } as Record<string, string> }
}

beforeAll(async () => {
  ctx = await makeApp(new FakeLlm([]))
  await req('POST', `${A}/vaults/notizen/notes`, { title: 'Rezept', type: 'note', folder: 'Rezepte' })
  await req('POST', `${A}/vaults/notizen/notes`, { title: 'Privat', type: 'note', folder: 'Privat' })
})
afterAll(async () => ctx?.cleanup())

describe('Konten mit Rechten je Notizbuch', () => {
  it('Unterschiedliche Stufen je Vault, kein Zugriff auf den Server', async () => {
    const u = await req('POST', `${A}/users`, { username: 'mitglied', password: 'geheim-12345', role: 'member', grants: [{ vault: 'dnd', access: 'read' }, { vault: 'notizen', access: 'write' }] })
    expect(u.status).toBe(201)
    expect(u.json.access).toEqual([{ vault: 'dnd', access: 'read' }, { vault: 'notizen', access: 'write' }])
    const { me, h } = await login('mitglied', 'geheim-12345')
    expect(me.server_admin).toBe(false)
    expect((await req('POST', `${A}/vaults/dnd/notes`, { title: 'Nein' }, h)).status).toBe(403)
    expect((await req('GET', `${A}/vaults/dnd/notes`, undefined, h)).status).toBe(200)
    expect((await req('POST', `${A}/vaults/notizen/notes`, { title: 'Ja' }, h)).status).toBe(201)
    expect((await req('GET', `${A}/users`, undefined, h)).status).toBe(403)
    expect((await req('GET', `${A}/vaults`, undefined, h)).json.items.length).toBe(2)
  })

  it('Rechte ändern meldet ab und wirkt beim nächsten Anmelden', async () => {
    const u = await req('POST', `${A}/users`, { username: 'wechsel', password: 'geheim-12345', role: 'member', grants: [{ vault: 'dnd', access: 'read' }] })
    const { h } = await login('wechsel', 'geheim-12345')
    expect((await req('PATCH', `${A}/users/${u.json.id}`, { grants: [{ vault: 'notizen', access: 'admin' }] })).status).toBe(200)
    expect((await req('GET', `${A}/vaults`, undefined, h)).status).toBe(401)
    const again = await login('wechsel', 'geheim-12345')
    expect((await req('GET', `${A}/vaults/dnd`, undefined, again.h)).status).toBe(403)
    // Verwalten eines Notizbuchs: Einstellungen ja, Server nein
    expect((await req('GET', `${A}/vaults/notizen/config`, undefined, again.h)).status).toBe(200)
    expect((await req('POST', `${A}/tokens`, { name: 'x', scopes: ['admin'] }, again.h)).status).toBe(403)
    expect(again.me.server_admin).toBe(false)
  })

  it('Bereich gilt auch für Konten, der Dateibaum zeigt nur den Bereich', async () => {
    await req('POST', `${A}/users`, { username: 'bereich', password: 'geheim-12345', role: 'member', grants: [{ vault: 'notizen', access: 'read', folders: ['Rezepte'] }] })
    const { h } = await login('bereich', 'geheim-12345')
    const tree = await req('GET', `${A}/vaults/notizen/tree`, undefined, h)
    expect(tree.status).toBe(200)
    expect(tree.json.notes.map((n: any) => n.title)).toEqual(['Rezept'])
    expect(tree.json.folders).toEqual([])
    // Auch die Anzahl verrät nichts außerhalb des Bereichs
    expect((await req('GET', `${A}/vaults`, undefined, h)).json.items[0].note_count).toBe(1)
    expect((await req('GET', `${A}/vaults/notizen`)).json.note_count).toBeGreaterThan(1)
    const full = await req('GET', `${A}/vaults/notizen/tree`)
    expect(full.json.notes.map((n: any) => n.title)).toContain('Privat')
  })

  it('Ältere Rollen laufen weiter und werden beim Umstellen zu Mitgliedern', async () => {
    const u = await req('POST', `${A}/users`, { username: 'alt', password: 'geheim-12345', role: 'editor', vaults: ['dnd'] })
    expect(u.json.access).toEqual([{ vault: 'dnd', access: 'write_curate' }])
    const { h } = await login('alt', 'geheim-12345')
    expect((await req('POST', `${A}/vaults/dnd/notes`, { title: 'Alt' }, h)).status).toBe(201)
    const up = await req('PATCH', `${A}/users/${u.json.id}`, { role: 'member', grants: u.json.access })
    expect(up.json).toMatchObject({ role: 'member', access: [{ vault: 'dnd', access: 'write_curate' }] })
    const v = await req('POST', `${A}/users`, { username: 'spieler2', password: 'geheim-12345', role: 'player', vaults: ['dnd'], campaign: 'Regarion' })
    expect(v.json.access).toEqual([{ vault: 'dnd', access: 'read', campaign: 'Regarion', shared: true }])
    expect((await login('spieler2', 'geheim-12345')).me.visibility).toBe('players')
  })

  it('Unbekannter Vault und ungültige Stufe werden abgelehnt; Mitglied ohne Rechte sieht nichts', async () => {
    expect((await req('POST', `${A}/users`, { username: 'a1', password: 'geheim-12345', role: 'member', grants: [{ vault: 'gibtsnicht', access: 'read' }] })).status).toBe(404)
    expect((await req('POST', `${A}/users`, { username: 'a2', password: 'geheim-12345', role: 'member', grants: [{ vault: 'dnd', access: 'superuser' }] })).status).toBe(400)
    await req('POST', `${A}/users`, { username: 'leer', password: 'geheim-12345', role: 'member' })
    const { h } = await login('leer', 'geheim-12345')
    expect((await req('GET', `${A}/vaults`, undefined, h)).json.items).toEqual([])
    expect((await req('GET', `${A}/vaults/dnd`, undefined, h)).status).toBe(403)
  })
})
