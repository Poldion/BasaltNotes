import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeLlm, makeApp } from './helpers.js'

let ctx: Awaited<ReturnType<typeof makeApp>>
const V = '/api/v1/vaults/dnd'
const req = async (method: string, url: string, body?: any) => {
  const r = await ctx.app.inject({ method: method as any, url, payload: body, headers: ctx.auth })
  return { status: r.statusCode, json: r.json() as any }
}
const get = async (url: string) => (await req('GET', url)).json
const titles = async (type: string) => (await get(`${V}/notes?type=${type}&limit=200&fields=title`)).items.map((n: any) => n.title).sort()
const ent = (name: string, type: string, extra: any = {}) => ({ name, type, mentioned_as: [], summary: '', facts: [`Fakt über ${name}`], properties: {}, visibility: 'players', confidence: 1, ...extra })

beforeAll(async () => {
  ctx = await makeApp(
    new FakeLlm([
      // Bestehende Einträge ohne Kampagne, neuer Text mit Kampagne
      { match: /IMPORT-1/, result: { entities: [ent('Kefir', 'npc'), ent('Fyrn Linstök', 'npc'), ent('Valerius', 'npc')], events: [], quests: [], facts: [], relations: [] } },
      // Kurzform und voller Name im selben Text
      { match: /IMPORT-2/, result: { entities: [ent('Xaros', 'npc'), ent('Xaros "Bitterkraut"', 'npc', { facts: ['Kräuterhändler'] })], events: [], quests: [], facts: [], relations: [] } },
    ]),
  )
})
afterAll(async () => ctx?.cleanup())

describe('Weniger Duplikate beim Import', () => {
  it('Einträge ohne Kampagne werden gefunden statt „Kefir 2“ anzulegen; Kurzform passt zum vollen Namen', async () => {
    await req('POST', `${V}/notes`, { type: 'npc', title: 'Kefir', body: '# Kefir\n\nKoboldmagier.\n' })
    await req('POST', `${V}/notes`, { type: 'npc', title: 'Fyrn' })
    await req('POST', `${V}/notes`, { type: 'npc', title: 'Valerius Vau' })
    await req('POST', `${V}/inbox`, { note: { type: 'script', title: 'Teil 1', frontmatter: { campaign: 'Regarion' }, body: 'IMPORT-1' } })
    await ctx.services.jobs.drain()
    expect(await titles('npc')).toEqual(['Fyrn', 'Kefir', 'Valerius Vau'])
    expect((await get(`${V}/notes/by-title?title=Kefir`)).body).toContain('Fakt über Kefir')
    // Voller Name bleibt als Alias erhalten
    expect((await get(`${V}/notes/by-title?title=Fyrn`)).aliases).toContain('Fyrn Linstök')
    // Das LLM bekam die Einträge ohne Kampagne in der Namensliste
    const call = (ctx.services.llm as FakeLlm).calls.find((c) => /IMPORT-1/.test(c.user))!
    expect(call.system).toMatch(/Kefir \(npc\)/)
  })

  it('Kurzform und voller Name im selben Text ergeben einen Eintrag mit vollem Namen', async () => {
    await req('POST', `${V}/inbox`, { note: { type: 'script', title: 'Teil 2', frontmatter: { campaign: 'Regarion' }, body: 'IMPORT-2' } })
    await ctx.services.jobs.drain()
    const npcs = await titles('npc')
    expect(npcs).toContain('Xaros "Bitterkraut"')
    expect(npcs).not.toContain('Xaros')
    const x = await get(`${V}/notes/by-title?title=Xaros`)
    expect(x.title).toBe('Xaros "Bitterkraut"')
    expect(x.body).toContain('Fakt über Xaros')
    expect(x.body).toContain('Kräuterhändler')
  })
})

describe('Duplikate suchen (ohne LLM)', () => {
  it('findet gleiche Titel, Alias, Kurzform, Schreibvarianten und gleiche Titel mit anderem Typ', async () => {
    const mk = async (type: string, title: string, extra: any = {}) => (await req('POST', `${V}/notes`, { type, title, ...extra })).json
    const k2 = await mk('npc', 'Kefir', { frontmatter: { role: 'Koboldmagier', campaign: 'Regarion' }, body: '# Kefir\n\n## Beschreibung\n\n## Motive (DM)\n\nHasst Gerüche.\n' })
    await req('PUT', `${V}/notes/${k2.id}/blocks/${encodeURIComponent('upload:abc')}`, { content: '- Hat die Muffgallerte gebaut', heading: 'Aus den Sessions' })
    await mk('npc', 'Lyria', { frontmatter: { aliases: ['Lylra'] } })
    await mk('npc', 'Lylra')
    await mk('quest', 'Eberjagd')
    await mk('quest', 'Die Eber Jagd')
    await mk('location', 'Suche nach den Kultisten')
    await mk('quest', 'Suche nach den Kultisten')
    await mk('monster', "Xal'Vroth")
    await mk('monster', "Xal'Vroth, der Säure-Messias")
    await mk('location', 'Raum A')
    await mk('location', 'Raum B')
    const host = await mk('note', 'Notiz', { body: 'Siehe [[Kefir]] und [[Lylra]].\n' })

    const dry = (await req('POST', `${V}/curator/duplicates?dry_run=1`)).json
    const pairs: string[] = dry.pairs.map((p: any) => `${p.other.title}→${p.keep.title}`)
    expect(pairs).toContain('Kefir→Kefir')
    expect(pairs).toContain('Lylra→Lyria')
    expect(pairs).toContain("Xal'Vroth→Xal'Vroth, der Säure-Messias")
    // Beim Import schon richtig zugeordnet → kein Duplikat
    expect(pairs.some((p) => p.startsWith('Valerius'))).toBe(false)
    expect(pairs.some((p) => /Eber/.test(p))).toBe(true)
    expect(pairs).toContain('Suche nach den Kultisten→Suche nach den Kultisten')
    expect(pairs.some((p) => /Raum/.test(p))).toBe(false)
    expect(dry.created).toBe(0)

    const res = (await req('POST', `${V}/curator/duplicates`)).json
    expect(res.created).toBe(dry.pairs.length)
    const props = (await get(`${V}/proposals`)).items.filter((p: any) => p.kind === 'merge_entities')
    expect(props.length).toBe(res.created)

    // Zweiter Lauf schlägt nichts doppelt vor
    expect((await req('POST', `${V}/curator/duplicates`)).json.created).toBe(0)

    // Kefir zusammenführen: Bereiche wandern als Bereiche, Eigenschaften werden übernommen, Links bleiben gültig
    const kefirProp = (await get(`${V}/proposals?diff=1`)).items.find((p: any) => p.operation.other_title === 'Kefir' && p.operation.note_title === 'Kefir')
    expect(kefirProp.diff).toContain('Hat die Muffgallerte gebaut')
    await req('POST', `${V}/proposals/${kefirProp.id}/accept`)
    const kefirs = (await get(`${V}/notes?type=npc&limit=100&fields=title`)).items.filter((n: any) => n.title === 'Kefir')
    expect(kefirs).toHaveLength(1)
    const kefir = await get(`${V}/notes/${kefirs[0].id}`)
    expect(kefir.frontmatter.role).toBe('Koboldmagier')
    expect(kefir.blocks.map((b: any) => b.key)).toContain('upload:abc')
    expect(kefir.body).toContain('Hasst Gerüche.')
    // Leere Vorlagen-Überschriften wurden nicht mitkopiert
    expect(kefir.body).not.toMatch(/Zusammengeführt aus Kefir[\s\S]*## Beschreibung/)
    expect((await get(`${V}/notes/${host.id}/links`)).items.every((l: any) => l.resolved)).toBe(true)

    // Abgelehnte Paare kommen nicht wieder
    const eber = props.find((p: any) => /Eber/.test(p.title))
    await req('POST', `${V}/proposals/${eber.id}/reject`)
    expect((await req('POST', `${V}/curator/duplicates?dry_run=1`)).json.pairs.some((p: any) => /Eber/.test(p.other.title))).toBe(false)
  })
})
