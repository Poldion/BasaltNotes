import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeLlm, makeApp } from './helpers.js'

let ctx: Awaited<ReturnType<typeof makeApp>>
let llm: FakeLlm
const V = '/api/v1/vaults/dnd'
const get = async (url: string) => (await ctx.app.inject({ method: 'GET', url, headers: ctx.auth })).json() as any

beforeAll(async () => {
  llm = new FakeLlm([
    { match: /GALLERTE-1/, result: { entities: [{ name: 'Muffgallerte', type: 'item', mentioned_as: [], summary: '', facts: ['Riecht'], properties: {}, visibility: 'players', confidence: 1 }], events: [], quests: [], facts: [] } },
    { match: /GALLERTE-2/, result: { entities: [{ name: 'Muffgallerte', type: 'monster', mentioned_as: [], summary: 'Gallertwürfel', facts: ['Greift an'], properties: { cr: '2', creature_type: 'Schleim' }, visibility: 'players', confidence: 1 }], events: [], quests: [], facts: [] } },
  ])
  ctx = await makeApp(llm)
})
afterAll(async () => ctx?.cleanup())

describe('Typ Monster', () => {
  it('ist im D&D-Vault vorhanden mit Ordner, Vorlage und Eigenschaften', async () => {
    const t = (await get(`${V}/types`)).items.find((x: any) => x.name === 'monster')
    expect(t.label).toBe('Monster')
    expect(t.properties.map((p: any) => p.name)).toEqual(expect.arrayContaining(['cr', 'ac', 'hp', 'creature_type', 'status']))
    const r = await ctx.app.inject({ method: 'POST', url: `${V}/notes`, headers: ctx.auth, payload: { type: 'monster', title: 'Schleimmonster', frontmatter: { campaign: 'Regarion' } } })
    expect(r.json().path).toBe('Regarion/Monster/Schleimmonster.md')
    expect(r.json().body).toContain('## Taktik')
  })

  it('Vault auf Stand 0.6 (Revision 2) bekommt nur Monster nachgerüstet', async () => {
    const v = ctx.services.vaults.get('dnd')
    const file = path.join(v.dir, '.basalt', 'vault.yaml')
    const yaml = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(file, yaml.replace(/^preset_revision:.*$/m, 'preset_revision: 2').replace(/^  monster:\n(    .*\n)+/m, ''))
    expect(v.loadConfig().types.monster).toBeTruthy()
    expect(fs.readFileSync(file, 'utf8')).toMatch(/preset_revision: 4/)
  })

  it('Kurator kennt Monster; widersprüchliche Typen ergeben ein Monster statt eines Gegenstands', async () => {
    const text = `GALLERTE-1\n${'Füllsatz. '.repeat(700)}\n\n## Weiter\n\nGALLERTE-2\n${'Füllsatz. '.repeat(700)}`
    await ctx.app.inject({ method: 'POST', url: `${V}/inbox`, headers: ctx.auth, payload: { note: { type: 'script', title: 'Tunnel', frontmatter: { campaign: 'Regarion' }, body: text } } })
    await ctx.services.jobs.drain()
    const call = llm.calls.find((c) => /GALLERTE-1/.test(c.user))!
    expect(call.system).toMatch(/"monster"/)
    expect((call.schema as any).properties.entities.items.properties.type.enum).toContain('monster')
    const notes = (await get(`${V}/notes?limit=100&fields=title,type,path`)).items.filter((n: any) => n.title === 'Muffgallerte')
    expect(notes).toHaveLength(1)
    expect(notes[0].type).toBe('monster')
    expect(notes[0].path).toBe('Regarion/Monster/Muffgallerte.md')
    const m = await get(`${V}/notes/${notes[0].id}`)
    expect(m.frontmatter.cr).toBe('2')
  })
})
