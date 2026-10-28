import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeLlm, makeApp } from './helpers.js'

let ctx: Awaited<ReturnType<typeof makeApp>>
const V = '/api/v1/vaults/dnd'
const get = async (url: string) => (await ctx.app.inject({ method: 'GET', url, headers: ctx.auth })).json() as any
const q = (s: string) => encodeURIComponent(s)

const STUNK = {
  entities: [
    { name: 'Meller Wraant', type: 'npc', mentioned_as: ['Schmiedin', 'Meller'], summary: 'Schmiedin', facts: ['Heuert die Gruppe an'], properties: {}, visibility: 'players', confidence: 1 },
    { name: 'Muffgallerte', type: 'monster', mentioned_as: [], summary: 'Gallertwürfel', facts: ['Verursacht den Gestank'], properties: {}, visibility: 'players', confidence: 1 },
    { name: 'Die uralten Tunnel', type: 'location', mentioned_as: ['Tunnel'], summary: 'Unter dem Dorf', facts: ['Unter Olibers Fleck'], properties: {}, visibility: 'players', confidence: 1 },
    { name: 'Olibers Fleck', type: 'location', mentioned_as: [], summary: 'Dorf', facts: ['Stinkt seit Monaten'], properties: {}, visibility: 'players', confidence: 1 },
  ],
  events: [],
  quests: [{ title: 'Beseitigung des Gestanks', status: 'offen', giver: null, summary: 'Die Gallerte loswerden' }],
  facts: [],
  relations: [
    { from: 'Beseitigung des Gestanks', to: 'Meller Wraant', kind: 'giver', label: 'Questgeber', inverse: 'gibt Quest' },
    { from: 'Beseitigung des Gestanks', to: 'Muffgallerte', kind: 'target', label: 'Ziel', inverse: 'Ziel von' },
    { from: 'Muffgallerte', to: 'Tunnel', kind: 'location', label: 'Aufenthaltsort', inverse: 'Bewohner' },
    { from: 'Die uralten Tunnel', to: 'Olibers Fleck', kind: 'parent', label: 'Liegt unter', inverse: 'Darunter' },
    { from: 'Unbekannt', to: 'Muffgallerte', kind: 'enemy', label: 'Feind', inverse: 'Feind' },
  ],
}

const SPAETER = {
  entities: [{ name: 'Fyrn Linstök', type: 'npc', mentioned_as: [], summary: 'Kerzenzieher', facts: ['Wohnt in Olibers Fleck'], properties: {}, visibility: 'players', confidence: 1 }],
  events: [],
  quests: [],
  facts: [],
  relations: [
    { from: 'Fyrn Linstök', to: 'Olibers Fleck', kind: 'location', label: 'Wohnort', inverse: 'Bewohner' },
    // Bestehende Quest (aus dem ersten Text) mit neuem Bezug; bestehender NPC ohne Ort → Vorschlag
    { from: 'Meller Wraant', to: 'Olibers Fleck', kind: 'location', label: 'Wohnort', inverse: 'Bewohner' },
  ],
}

beforeAll(async () => {
  ctx = await makeApp(new FakeLlm([
    { match: /STUNK/, result: STUNK },
    { match: /SPAETER/, result: SPAETER },
  ]))
})
afterAll(async () => ctx?.cleanup())

describe('Beziehungen zwischen Einträgen', () => {
  it('verknüpft Quest, Questgeber, Monster und Orte in beide Richtungen und setzt Eigenschaften', async () => {
    await ctx.app.inject({ method: 'POST', url: `${V}/inbox`, headers: ctx.auth, payload: { note: { type: 'script', title: 'Stunk', frontmatter: { campaign: 'Regarion' }, body: 'STUNK' } } })
    await ctx.services.jobs.drain()

    const quest = await get(`${V}/notes/by-title?title=${q('Beseitigung des Gestanks')}`)
    expect(quest.frontmatter.giver).toBe('[[Meller Wraant]]')
    expect(quest.body).toContain('## Beziehungen')
    expect(quest.body).toContain('Questgeber: [[Meller Wraant]]')
    expect(quest.body).toContain('Ziel: [[Muffgallerte]]')

    const gallerte = await get(`${V}/notes/by-title?title=Muffgallerte`)
    expect(gallerte.type).toBe('monster')
    expect(gallerte.frontmatter.location).toBe('[[Die uralten Tunnel]]')
    expect(gallerte.body).toContain('Ziel von: [[Beseitigung des Gestanks]]')
    expect(gallerte.body).toContain('Aufenthaltsort: [[Die uralten Tunnel]]')
    // Unbekannte Namen werden ignoriert
    expect(gallerte.body).not.toContain('Unbekannt')

    const meller = await get(`${V}/notes/by-title?title=${q('Meller Wraant')}`)
    expect(meller.body).toContain('gibt Quest: [[Beseitigung des Gestanks]]')
    expect(meller.frontmatter.role).toBe('Schmiedin')
    expect(meller.aliases).toEqual(['Meller'])
    expect((await get(`${V}/notes/${meller.id}/backlinks`)).items.map((b: any) => b.source_title)).toContain('Beseitigung des Gestanks')

    const tunnel = await get(`${V}/notes/by-title?title=${q('Die uralten Tunnel')}`)
    expect(tunnel.frontmatter.parent).toBe('[[Olibers Fleck]]')
    expect(tunnel.body).toContain('Bewohner: [[Muffgallerte]]')

    // Skripte sind DM-Wissen → Beziehungen im DM-Bereich
    expect(gallerte.blocks.find((b: any) => b.key.endsWith(':rel:dm'))).toBeTruthy()

    // Graph hat die Kante Quest → Monster
    const graph = await get(`${V}/graph`)
    expect(graph.edges.some((e: any) => e.source === quest.id && e.target === gallerte.id)).toBe(true)
  })

  it('bestehende Einträge: Beziehung als Abschnitt, leere Eigenschaft nur als Vorschlag', async () => {
    await ctx.app.inject({ method: 'POST', url: `${V}/inbox`, headers: ctx.auth, payload: { note: { type: 'script', title: 'Später', frontmatter: { campaign: 'Regarion' }, body: 'SPAETER' } } })
    await ctx.services.jobs.drain()
    const meller = await get(`${V}/notes/by-title?title=${q('Meller Wraant')}`)
    expect(meller.frontmatter.location).toBeUndefined()
    expect(meller.body).toContain('Wohnort: [[Olibers Fleck]]')
    const props = (await get(`${V}/proposals`)).items
    const p = props.find((x: any) => x.kind === 'update_property' && x.operation.field === 'location' && x.note_id === meller.id)
    expect(p.operation.to).toBe('[[Olibers Fleck]]')
    const fyrn = await get(`${V}/notes/by-title?title=${q('Fyrn Linstök')}`)
    expect(fyrn.frontmatter.location).toBe('[[Olibers Fleck]]')
    const dorf = await get(`${V}/notes/by-title?title=${q('Olibers Fleck')}`)
    expect(dorf.body).toContain('Bewohner: [[Fyrn Linstök]]')
    expect(dorf.body).toContain('Darunter: [[Die uralten Tunnel]]')
  })
})
