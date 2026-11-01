import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeLlm, makeApp } from './helpers.js'

let ctx: Awaited<ReturnType<typeof makeApp>>
const A = '/api/v1'
const req = async (method: string, url: string, body?: any, headers: Record<string, string> = ctx.auth) => {
  const r = await ctx.app.inject({ method: method as any, url, payload: body, headers })
  return { status: r.statusCode, json: r.json() as any }
}
const token = async (body: any) => {
  const r = await req('POST', `${A}/tokens`, body)
  expect(r.status).toBe(201)
  return { authorization: `Bearer ${r.json.token}` }
}

beforeAll(async () => {
  ctx = await makeApp(new FakeLlm([]))
})
afterAll(async () => ctx?.cleanup())

describe('Eigene Vaults per create_vault', () => {
  it('Token legt einen Vault an und hat nur dort alle Rechte', async () => {
    const t = await token({ name: 'app', scopes: ['create_vault'] })
    expect((await req('GET', `${A}/vaults`, undefined, t)).json.items).toEqual([])

    const c = await req('POST', `${A}/vaults`, { name: 'Meine App' }, t)
    expect(c.status).toBe(201)
    expect((await req('GET', `${A}/vaults`, undefined, t)).json.items.map((v: any) => v.id)).toEqual(['meine-app'])

    const n = await req('POST', `${A}/vaults/meine-app/notes`, { title: 'Hallo' }, t)
    expect(n.status).toBe(201)
    expect((await req('GET', `${A}/vaults/meine-app/notes/${n.json.id}`, undefined, t)).status).toBe(200)
    expect((await req('PATCH', `${A}/vaults/meine-app`, { name: 'Umbenannt' }, t)).status).toBe(200)

    // Fremde Vaults und Serververwaltung bleiben gesperrt
    expect((await req('GET', `${A}/vaults/dnd`, undefined, t)).status).toBe(403)
    expect((await req('GET', `${A}/vaults/dnd/notes`, undefined, t)).status).toBe(403)
    expect((await req('DELETE', `${A}/vaults/dnd`, undefined, t)).status).toBe(403)
    expect((await req('GET', `${A}/tokens`, undefined, t)).status).toBe(403)
    expect((await req('POST', `${A}/tokens`, { name: 'x', scopes: ['admin'] }, t)).status).toBe(403)
    expect((await req('POST', `${A}/vaults/example`, undefined, t)).status).toBe(403)
  })

  it('Ohne create_vault kein Anlegen; vergebener Name ergibt 409', async () => {
    const r = await token({ name: 'leser', scopes: ['read'], vaults: ['dnd'] })
    expect((await req('POST', `${A}/vaults`, { name: 'Nein' }, r)).status).toBe(403)
    const t = await token({ name: 'app2', scopes: ['create_vault'] })
    expect((await req('POST', `${A}/vaults`, { name: 'DnD' }, t)).status).toBe(409)
    expect((await req('GET', `${A}/vaults/dnd`, undefined, t)).status).toBe(403)
  })

  it('Gelöschter Vault gehört dem Token nicht mehr, auch nicht bei gleichem Namen', async () => {
    const t = await token({ name: 'app3', scopes: ['create_vault'] })
    await req('POST', `${A}/vaults`, { name: 'Kurzlebig' }, t)
    expect((await req('DELETE', `${A}/vaults/kurzlebig`, undefined, t)).status).toBe(200)
    expect((await req('POST', `${A}/vaults`, { name: 'Kurzlebig' })).status).toBe(201)
    expect((await req('GET', `${A}/vaults/kurzlebig`, undefined, t)).status).toBe(403)
  })

  it('Zugang mit Freigaben: Bereich bleibt beschränkt, eigener Vault frei, auch nach Änderung der Freigaben', async () => {
    const created = await req('POST', `${A}/tokens`, { name: 'app4', scopes: ['create_vault'], grants: [{ vault: 'dnd', access: 'read' }] })
    const t = { authorization: `Bearer ${created.json.token}` }
    expect((await req('POST', `${A}/vaults`, { name: 'Vier' }, t)).status).toBe(201)
    expect((await req('POST', `${A}/vaults/dnd/notes`, { title: 'Nein' }, t)).status).toBe(403)
    expect((await req('POST', `${A}/vaults/vier/notes`, { title: 'Ja' }, t)).status).toBe(201)
    await req('PATCH', `${A}/tokens/${created.json.id}`, { grants: [{ vault: 'dnd', access: 'read' }] })
    expect((await req('POST', `${A}/vaults`, { name: 'Fünf' }, t)).status).toBe(201)
    expect((await req('GET', `${A}/vaults/vier`, undefined, t)).status).toBe(200)
  })

  it('Nicht zusammen mit Spieler-Sicht; höchstens 20 eigene Vaults', async () => {
    expect((await req('POST', `${A}/tokens`, { name: 'x', scopes: ['create_vault'], visibility: 'players' })).status).toBe(400)
    const t = await token({ name: 'viel', scopes: ['create_vault'] })
    for (let i = 0; i < 20; i++) expect((await req('POST', `${A}/vaults`, { name: `Viel ${i}` }, t)).status).toBe(201)
    expect((await req('POST', `${A}/vaults`, { name: 'Viel 20' }, t)).status).toBe(403)
    // 20 Vaults mit je einem git-Repo dauern unter Last länger als das Standardlimit
  }, 60_000)

  it('Eigener Vault: Ordner aus vault.yaml oder Anfrage führen nicht aus dem Vault heraus', async () => {
    const t = await token({ name: 'pfad', scopes: ['create_vault'] })
    await req('POST', `${A}/vaults`, { name: 'Pfad' }, t)
    const cfg = (await req('GET', `${A}/vaults/pfad/config`, undefined, t)).json
    const parsed = cfg.parsed
    parsed.types.note.folder = '../dnd/Eingeschleust'
    expect((await req('PUT', `${A}/vaults/pfad/config`, { yaml: JSON.stringify(parsed) }, t)).json.parsed.types.note.folder).toBe('../dnd/Eingeschleust')
    const before = fs.readdirSync(ctx.services.vaults.root)
    await req('POST', `${A}/vaults/pfad/notes`, { title: 'Weg' }, t)
    await req('POST', `${A}/vaults/pfad/notes`, { title: 'Weg2', folder: '../dnd/Eingeschleust' }, t)
    expect(fs.existsSync(path.join(ctx.services.vaults.root, 'dnd', 'Eingeschleust'))).toBe(false)
    expect(fs.readdirSync(ctx.services.vaults.root)).toEqual(before)
  })
})
