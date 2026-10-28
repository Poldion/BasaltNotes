/** Regressionstests aus dem echten Lauf „Regarion Teil 1 – Gestank“ */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nameSimilarity } from '../src/lib/similarity.js'
import { Curator } from '../src/curator/curator.js'
import { nowIso } from '../src/db.js'
import { FakeLlm, makeApp } from './helpers.js'

describe('Namensähnlichkeit (keine falschen Zusammenführungen)', () => {
  const different: [string, string][] = [
    ['Raum A', 'Raum B'],
    ['Langer Raum mit Steintischen - B', 'Quadratischer Raum mit Müllhalde - A'],
    ['Runder Raum mit drei Särgen - C', 'Quadratischer Raum mit Müllhalde - A'],
    ['Geheimer Raum - D', 'Quadratischer Raum mit Müllhalde - A'],
    ['Quadratischer Raum mit Müllhalde - A', 'Müllde'],
    ['Meller Wraant', 'Muffgallerte'],
    ['Wache 1', 'Wache 2'],
  ]
  for (const [a, b] of different) {
    it(`${a} ≠ ${b}`, () => expect(nameSimilarity(a, b)).toBeLessThan(0.75))
  }
  it('Schreibvarianten bleiben ähnlich', () => {
    expect(nameSimilarity('Sylvia', 'Zylia die Weise')).toBeGreaterThanOrEqual(0.6)
    expect(nameSimilarity('Meller', 'Meller Wraant')).toBeGreaterThanOrEqual(0.75)
    expect(nameSimilarity('Drog Bo', 'Drogbo')).toBeGreaterThanOrEqual(0.9)
  })
})

describe('Kurator', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>
  const V = '/api/v1/vaults/dnd'
  const EX1 = {
    entities: [
      { name: 'Meller Wraant', type: 'npc', mentioned_as: ['Meller'], summary: 'Schmiedin', facts: ['Heuert die Gruppe an'], properties: { role: 'Schmiedin' }, visibility: 'players', confidence: 1 },
      { name: 'Muffgallerte', type: 'item', mentioned_as: [], summary: 'Glibber', facts: ['Riecht furchtbar'], properties: {}, visibility: 'players', confidence: 1 },
      { name: 'Raum A', type: 'location', mentioned_as: [], summary: '', facts: ['Müllhalde'], properties: {}, visibility: 'players', confidence: 1 },
      { name: 'Raum B', type: 'location', mentioned_as: [], summary: '', facts: ['Steintische'], properties: {}, visibility: 'players', confidence: 1 },
    ],
    events: [],
    quests: [],
    facts: [],
  }
  const EX2 = {
    entities: [{ name: 'Muffgallerte', type: 'npc', mentioned_as: [], summary: 'Gallertwürfel', facts: ['Bewegt sich durch die Tunnel'], properties: {}, visibility: 'players', confidence: 1 }],
    events: [],
    quests: [],
    facts: [],
  }

  beforeAll(async () => {
    ctx = await makeApp(new FakeLlm([
      { match: /TEIL-EINS/, result: EX1 },
      { match: /TEIL-ZWEI/, result: EX2 },
    ]))
  })
  afterAll(async () => ctx?.cleanup())

  const get = async (url: string) => (await ctx.app.inject({ method: 'GET', url, headers: ctx.auth })).json() as any

  it('Gleicher Name in zwei Abschnitten mit anderem Typ → eine Notiz; DM-Dokument verlinkt alle Einträge', async () => {
    // Zwei Abschnitte erzwingen: Text > 12.000 Zeichen
    const text = `TEIL-EINS\n${'Füllsatz über das Dorf. '.repeat(300)}\n\n## Teil zwei\n\nTEIL-ZWEI\n${'Füllsatz über die Tunnel. '.repeat(300)}`
    const res = await ctx.app.inject({
      method: 'POST',
      url: `${V}/inbox`,
      headers: ctx.auth,
      payload: { source: { app: 'upload', key: 'upload:test1' }, note: { type: 'script', title: 'Stunk', frontmatter: { visibility: 'dm' }, body: text }, document: undefined, curate: 'auto' },
    })
    expect(res.statusCode).toBe(202)
    await ctx.services.jobs.drain()
    const run = (await get(`${V}/runs`)).items[0]
    expect(run.status).toBe('done')
    expect(run.llm.chunks).toBe(2)

    const gallerte = (await get(`${V}/notes?limit=100&fields=title,type`)).items.filter((n: any) => n.title === 'Muffgallerte')
    expect(gallerte).toHaveLength(1)
    expect(gallerte[0].type).toBe('npc')

    // Keine unsinnigen Zusammenführ-Vorschläge (Raum A / Raum B, Meller / Muffgallerte)
    const props = (await get(`${V}/proposals?status=all`)).items
    expect(props.filter((p: any) => p.kind === 'merge_entities')).toHaveLength(0)

    // Skript verlinkt alle Einträge (Skripte sind DM-Wissen → eigener DM-Bereich) → Backlinks
    const meller = await get(`${V}/notes/by-title?title=Meller%20Wraant`)
    expect(meller.visibility).toBe('dm')
    const bl = (await get(`${V}/notes/${meller.id}/backlinks`)).items
    expect(bl.map((b: any) => b.source_title)).toContain('Stunk')
    const script = await get(`${V}/notes/by-title?title=Stunk`)
    expect(script.blocks.find((b: any) => b.key === 'upload:test1:links:dm').visibility).toBe('dm')
  })

  it('Unterbrochene Läufe stehen nach einem Neustart nicht mehr auf „läuft“', async () => {
    const { db, vaults, llm, events } = ctx.services
    db.run("INSERT INTO runs (id, vault, source_key, mode, status, created) VALUES ('alt', 'dnd', 'x', 'auto', 'running', ?)", nowIso())
    new Curator(db, vaults, llm, events)
    expect(db.get<any>("SELECT status, error FROM runs WHERE id = 'alt'")).toMatchObject({ status: 'interrupted' })
  })
})
