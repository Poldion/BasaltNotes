import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeLlm, makeApp } from './helpers.js'

let ctx: Awaited<ReturnType<typeof makeApp>>
const V = '/api/v1/vaults/dnd'
const get = async (url: string) => (await ctx.app.inject({ method: 'GET', url, headers: ctx.auth })).json() as any
const text = async (url: string) => (await ctx.app.inject({ method: 'GET', url, headers: ctx.auth })).body
const q = (s: string) => encodeURIComponent(s)

const DIREKT = {
  entities: [
    {
      name: 'Die uralten Tunnel',
      type: 'location',
      mentioned_as: [],
      summary: 'Tunnel unter dem Dorf',
      facts: ['Riechen nach Müll'],
      properties: {},
      visibility: 'players',
      confidence: 1,
      rooms: [
        { name: 'Raum A – Quadratischer Raum mit Müllhalde', description: 'Insektenschwärme über einem Müllberg.' },
        { name: 'Raum C – Runder Raum mit drei Särgen', description: 'Drei Särge, aus denen Zombies steigen.' },
      ],
    },
    { name: 'Zombies', type: 'monster', mentioned_as: [], summary: 'Untote', facts: ['Steigen aus den Särgen'], properties: {}, visibility: 'players', confidence: 1 },
    { name: 'Schatulle', type: 'item', mentioned_as: [], summary: 'Kleine Kiste', facts: ['Liegt im Müll'], properties: {}, visibility: 'players', confidence: 1 },
    { name: 'Kobolde', type: 'monster', mentioned_as: [], summary: 'Gruppe', facts: ['Leben unter dem Dorf'], properties: { location: 'Die uralten Tunnel' }, visibility: 'players', confidence: 1 },
  ],
  events: [],
  quests: [],
  facts: [],
  relations: [
    { from: 'Zombies', to: 'Raum C', kind: 'location', label: 'Aufenthaltsort', inverse: 'Bewohner' },
    { from: 'Schatulle', to: 'Raum A', kind: 'location', label: 'Aufenthaltsort', inverse: 'Bewohner' },
  ],
}

const ALS_ORT = {
  entities: [
    { name: 'Die uralten Tunnel', type: 'location', mentioned_as: [], summary: '', facts: ['Unter dem Dorf'], properties: {}, visibility: 'players', confidence: 1 },
    { name: 'Geheimer Raum - D', type: 'location', mentioned_as: ['Raum D'], summary: 'Versteckte Kammer', facts: ['Enthält eine Schatulle'], properties: {}, visibility: 'players', confidence: 1 },
  ],
  events: [],
  quests: [],
  facts: [],
  relations: [{ from: 'Geheimer Raum - D', to: 'Die uralten Tunnel', kind: 'parent', label: 'Liegt in', inverse: 'Enthält' }],
}

beforeAll(async () => {
  ctx = await makeApp(new FakeLlm([
    { match: /DIREKT/, result: DIREKT },
    { match: /ALS-ORT/, result: ALS_ORT },
  ]))
})
afterAll(async () => ctx?.cleanup())

describe('Räume als Abschnitte im Ort', () => {
  it('Räume werden Unterabschnitte; Links springen zum Raum', async () => {
    await ctx.app.inject({ method: 'POST', url: `${V}/inbox`, headers: ctx.auth, payload: { note: { type: 'script', title: 'Tunnel-Skript', frontmatter: { campaign: 'Regarion' }, body: 'DIREKT' } } })
    await ctx.services.jobs.drain()
    const notes = (await get(`${V}/notes?limit=100&fields=title,type`)).items
    expect(notes.filter((n: any) => n.type === 'location').map((n: any) => n.title)).toEqual(['Die uralten Tunnel'])

    const tunnel = await get(`${V}/notes/by-title?title=${q('Die uralten Tunnel')}`)
    expect(tunnel.body).toContain('## Räume')
    expect(tunnel.body).toContain('### Raum A – Quadratischer Raum mit Müllhalde\nInsektenschwärme über einem Müllberg.')
    // Bewohner stehen direkt unter dem Raum, nicht in einer Sammelliste
    expect(tunnel.body).toContain('### Raum C – Runder Raum mit drei Särgen\nDrei Särge, aus denen Zombies steigen.\n- Bewohner: [[Zombies]]')
    expect(tunnel.body).toContain('### Raum A – Quadratischer Raum mit Müllhalde\nInsektenschwärme über einem Müllberg.\n- Fundstück: [[Schatulle]]')

    const zombies = await get(`${V}/notes/by-title?title=Zombies`)
    expect(zombies.frontmatter.location).toBe('[[Die uralten Tunnel#Raum C – Runder Raum mit drei Särgen]]')
    // Eigenschaft vom LLM ohne Klammern wird zum Link
    expect((await get(`${V}/notes/by-title?title=Kobolde`)).frontmatter.location).toBe('[[Die uralten Tunnel]]')
    expect((await get(`${V}/notes/by-title?title=Schatulle`)).body).toContain('Fundort: [[Die uralten Tunnel#Raum A – Quadratischer Raum mit Müllhalde]]')
    expect(zombies.body).toContain('Aufenthaltsort: [[Die uralten Tunnel#Raum C – Runder Raum mit drei Särgen]]')
    // Link löst auf den Ort auf und springt per Anker zur Überschrift
    const link = zombies.links.find((l: any) => l.heading === 'Raum C – Runder Raum mit drei Särgen')
    expect(link.target_id).toBe(tunnel.id)
    const zHtml = await text(`${V}/notes/${zombies.id}/html`)
    const anchor = /href="[^"]*#([^"]+)"[^>]*data-heading="Raum C/.exec(zHtml)?.[1]
    expect(anchor).toBeTruthy()
    expect(await text(`${V}/notes/${tunnel.id}/html`)).toContain(`id="${anchor}"`)
  })

  it('Sicherheitsnetz: als Ort gelieferter Raum mit „liegt in“ wird Abschnitt des Ortes', async () => {
    await ctx.app.inject({ method: 'POST', url: `${V}/inbox`, headers: ctx.auth, payload: { note: { type: 'script', title: 'Tunnel-Skript 2', frontmatter: { campaign: 'Regarion' }, body: 'ALS-ORT' } } })
    await ctx.services.jobs.drain()
    expect((await ctx.app.inject({ method: 'GET', url: `${V}/notes/by-title?title=${q('Geheimer Raum - D')}`, headers: ctx.auth })).statusCode).toBe(404)
    const tunnel = await get(`${V}/notes/by-title?title=${q('Die uralten Tunnel')}`)
    expect(tunnel.body).toContain('### Geheimer Raum - D\nVersteckte Kammer Enthält eine Schatulle')
    // Räume aus dem ersten Skript bleiben erhalten (eigener Bereich je Quelle)
    expect(tunnel.body).toContain('### Raum A – Quadratischer Raum mit Müllhalde')
  })
})
