import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeLlm, makeApp } from './helpers.js'

let ctx: Awaited<ReturnType<typeof makeApp>>
const A = '/api/v1'
const req = async (method: string, url: string, body?: any, headers: Record<string, string> = ctx.auth) => {
  const r = await ctx.app.inject({ method: method as any, url, payload: body, headers })
  return { status: r.statusCode, json: r.json() as any }
}
const make = async (body: any) => {
  const r = await req('POST', `${A}/tokens`, body)
  expect(r.status).toBe(201)
  return { id: r.json.id as string, h: { authorization: `Bearer ${r.json.token}` } }
}
const inList = async (id: string) => (await req('GET', `${A}/tokens`)).json.items.find((t: any) => t.id === id)

beforeAll(async () => {
  ctx = await makeApp(new FakeLlm([]))
})
afterAll(async () => ctx?.cleanup())

describe('Einheitliche Rechte', () => {
  it('Stufen je Notizbuch', async () => {
    const inbox = await make({ name: 'i', grants: [{ vault: 'dnd', access: 'inbox' }] })
    expect((await req('POST', `${A}/vaults/dnd/inbox`, { text: 'Hallo' }, inbox.h)).status).toBeLessThan(300)
    expect((await req('GET', `${A}/vaults/dnd/notes`, undefined, inbox.h)).status).toBe(403)

    const manage = await make({ name: 'm', grants: [{ vault: 'dnd', access: 'admin' }] })
    expect((await req('GET', `${A}/vaults/dnd/config`, undefined, manage.h)).status).toBe(200)
    expect((await req('GET', `${A}/vaults/notizen`, undefined, manage.h)).status).toBe(403)
    // Verwalten eines Notizbuchs ist nicht Verwalten des Servers
    expect((await req('GET', `${A}/tokens`, undefined, manage.h)).status).toBe(403)
    expect((await req('POST', `${A}/tokens`, { name: 'x', scopes: ['admin'] }, manage.h)).status).toBe(403)
    expect((await req('POST', `${A}/vaults`, { name: 'Nein' }, manage.h)).status).toBe(403)

    const all = await make({ name: 'a', grants: [{ vault: '*', access: 'read' }] })
    expect((await req('GET', `${A}/vaults`, undefined, all.h)).json.items.length).toBeGreaterThan(1)
    expect((await req('GET', `${A}/vaults/notizen/notes`, undefined, all.h)).status).toBe(200)
    expect((await req('POST', `${A}/vaults/notizen/notes`, { title: 'Nein' }, all.h)).status).toBe(403)
    expect((await req('GET', `${A}/tokens`, undefined, all.h)).status).toBe(403)

    const server = await make({ name: 's', grants: [{ vault: '*', access: 'admin' }] })
    expect((await req('GET', `${A}/tokens`, undefined, server.h)).status).toBe(200)
  })

  it('Klassische Tokens: Admin für einzelne Vaults verwaltet den Server nicht mehr, sonst bleibt alles gleich', async () => {
    const one = await make({ name: 'k', scopes: ['admin'], vaults: ['dnd'] })
    expect((await req('GET', `${A}/tokens`, undefined, one.h)).status).toBe(403)
    expect((await req('GET', `${A}/vaults/dnd/config`, undefined, one.h)).status).toBe(200)
    const w = await make({ name: 'w', scopes: ['inbox', 'read'], vaults: ['dnd'] })
    expect((await req('GET', `${A}/vaults/dnd/notes`, undefined, w.h)).status).toBe(200)
    expect((await req('POST', `${A}/vaults/dnd/notes`, { title: 'Nein' }, w.h)).status).toBe(403)
    expect((await inList(w.id)).access).toEqual([{ vault: 'dnd', access: 'read_inbox' }])
  })

  it('Bereich geht nicht mit Kurator, Verwaltung oder „alle“', async () => {
    for (const g of [{ vault: 'dnd', access: 'admin', folders: ['A'] }, { vault: 'dnd', access: 'curate', types: ['npc'] }, { vault: '*', access: 'read', folders: ['A'] }]) {
      expect((await req('POST', `${A}/tokens`, { name: 'x', grants: [g] })).status).toBe(400)
    }
  })

  it('Rechte nachträglich ändern, Token-Wert bleibt, sofort wirksam', async () => {
    const t = await make({ name: 'alt', scopes: ['read'], vaults: ['dnd'] })
    expect((await req('POST', `${A}/vaults/dnd/notes`, { title: 'Vorher' }, t.h)).status).toBe(403)

    const up = await req('PATCH', `${A}/tokens/${t.id}`, { name: 'neu', grants: [{ vault: 'notizen', access: 'write' }], expires: '2099-01-01T00:00:00.000Z' })
    expect(up.status).toBe(200)
    expect(up.json).toMatchObject({ name: 'neu', expires: '2099-01-01T00:00:00.000Z', access: [{ vault: 'notizen', access: 'write' }] })
    expect((await req('GET', `${A}/vaults/dnd/notes`, undefined, t.h)).status).toBe(403)
    expect((await req('POST', `${A}/vaults/notizen/notes`, { title: 'Nachher' }, t.h)).status).toBe(201)

    // Eigene Vaults anlegen an- und abschalten, Name allein ändert keine Rechte
    expect((await req('POST', `${A}/vaults`, { name: 'Zu früh' }, t.h)).status).toBe(403)
    await req('PATCH', `${A}/tokens/${t.id}`, { create_vault: true })
    expect((await req('POST', `${A}/vaults`, { name: 'Jetzt' }, t.h)).status).toBe(201)
    await req('PATCH', `${A}/tokens/${t.id}`, { create_vault: false, name: 'neu2' })
    expect((await req('POST', `${A}/vaults`, { name: 'Wieder nein' }, t.h)).status).toBe(403)
    expect((await req('GET', `${A}/vaults/jetzt`, undefined, t.h)).status).toBe(200)
    expect((await req('POST', `${A}/vaults/notizen/notes`, { title: 'Noch' }, t.h)).status).toBe(201)

    // Ablauf wirkt sofort
    await req('PATCH', `${A}/tokens/${t.id}`, { expires: '2000-01-01T00:00:00.000Z' })
    expect((await req('GET', `${A}/vaults`, undefined, t.h)).status).toBe(401)
  })

  it('Nur eigene Vaults: ohne Freigaben möglich; Rechte nie ganz leer; Links nicht änderbar', async () => {
    const t = await make({ name: 'nur', grants: [], scopes: ['create_vault'] })
    expect((await req('POST', `${A}/vaults`, { name: 'Nur Eigen' }, t.h)).status).toBe(201)
    expect((await req('PATCH', `${A}/tokens/${t.id}`, { grants: [], create_vault: false })).status).toBe(400)
    expect((await req('PATCH', `${A}/tokens/${t.id}`, { grants: [{ vault: 'gibtsnicht', access: 'read' }] })).status).toBe(404)

    const share = await make({ name: 'link', scopes: ['read'], vaults: ['dnd'], visibility: 'players', kind: 'share' })
    expect((await req('PATCH', `${A}/tokens/${share.id}`, { grants: [{ vault: 'dnd', access: 'admin' }] })).status).toBe(409)
    const players = await make({ name: 'p', scopes: ['read'], vaults: ['dnd'], visibility: 'players' })
    expect((await req('PATCH', `${A}/tokens/${players.id}`, { create_vault: true })).status).toBe(400)
  })
})
