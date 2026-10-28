import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeLlm, makeApp } from './helpers.js'
import { EXTRACTION1, EXTRACTION2, SESSION1, SESSION2 } from './fixtures/sessions.js'

let ctx: Awaited<ReturnType<typeof makeApp>>
let llm: FakeLlm
const V = '/api/v1/vaults/dnd'

beforeAll(async () => {
  llm = new FakeLlm([
    { match: /Cydia bittet/, result: EXTRACTION1 },
    { match: /Sylvia wird feindselig/, result: EXTRACTION2 },
  ])
  ctx = await makeApp(llm)
})
afterAll(async () => ctx?.cleanup())

async function req(method: string, url: string, body?: any, headers: Record<string, string> = {}) {
  const res = await ctx.app.inject({ method: method as any, url, payload: body, headers: { ...ctx.auth, ...headers } })
  return { status: res.statusCode, json: res.json() as any }
}

const byTitle = async (title: string, type?: string) => (await req('GET', `${V}/notes/by-title?title=${encodeURIComponent(title)}${type ? `&type=${type}` : ''}`)).json

describe('Kurator (Golden-Test mit Schreibvarianten)', () => {
  let inbox1: any

  it('Einliefern legt Session-Notiz sofort an (202) und Kampagne bei Bedarf', async () => {
    const r = await req('POST', `${V}/inbox`, SESSION1, { 'idempotency-key': 'whispernotes:job:ab12cd34:v1' })
    expect(r.status).toBe(202)
    expect(r.json.status).toBe('queued')
    inbox1 = r.json
    const session = (await req('GET', `${V}/notes/${r.json.note_id}`)).json
    expect(session.path).toBe('Tests/Sessions/2026-10-11 Session 1.md')
    expect(session.frontmatter.source).toBe('whispernotes:job:ab12cd34')
    expect(session.frontmatter.number).toBe(1)
    expect(session.blocks.map((b: any) => b.key)).toEqual([
      'whispernotes:job:ab12cd34:recap',
      'whispernotes:job:ab12cd34:att:players-recap',
      'whispernotes:job:ab12cd34:att:lore',
    ])
    expect(session.blocks[2].visibility).toBe('dm')
    expect((await byTitle('Tests', 'campaign')).type).toBe('campaign')
  })

  it('Kurator legt Entitäten an, ordnet Varianten zu, schreibt nur in verwaltete Bereiche', async () => {
    await ctx.services.jobs.drain()
    const ib = (await req('GET', `${V}/inbox/${inbox1.inbox_id}`)).json
    expect(ib.status).toBe('processed')
    expect(ib.result.created).toBeGreaterThanOrEqual(5)

    const zylia = await byTitle('Zylia', 'npc')
    expect(zylia.path).toBe('Tests/NPCs/Zylia.md')
    expect(zylia.aliases).toContain('Cydia')
    expect(zylia.frontmatter.role).toBe('Karawanenführerin')
    expect(zylia.body).toContain('Bittet die Gruppe, den Streit')
    expect(zylia.blocks.find((b: any) => b.key === 'whispernotes:job:ab12cd34').source_note).toBe('[[2026-10-11 Session 1]]')
    // DM-Wissen in eigenem Bereich mit visibility=dm
    const dm = zylia.blocks.find((b: any) => b.key === 'whispernotes:job:ab12cd34:dm')
    expect(dm.visibility).toBe('dm')
    const players = (await req('GET', `${V}/notes/${zylia.id}?visibility=players`)).json
    expect(players.body).toContain('Bittet die Gruppe')
    expect(players.body).not.toContain('Verheimlicht ihre Herkunft')

    expect((await byTitle('Lyssara', 'character')).aliases).toContain('Lusara')
    expect((await byTitle('Brücke über den Bach', 'quest')).frontmatter.status).toBe('offen')
    const facts = await byTitle('Gesetzte Fakten', 'fact')
    expect(facts.body).toContain('Die Karawane fährt von Valerius nach Osten')
    expect(facts.blocks.find((b: any) => b.visibility === 'dm')).toBeTruthy()

    // Schleimmonster: confidence 0.6 < 0.8 → Vorschlag statt automatisch
    const p = (await req('GET', `${V}/proposals?status=open`)).json.items
    expect(p.find((x: any) => x.kind === 'create_entity' && x.operation.title === 'Schleimmonster')).toBeTruthy()
    expect((await req('GET', `${V}/notes/by-title?title=Schleimmonster`)).status).toBe(404)

    // Session verlinkt alle Entitäten → Backlinks
    const bl = (await req('GET', `${V}/notes/${zylia.id}/backlinks`)).json.items
    expect(bl.map((b: any) => b.source_title)).toContain('2026-10-11 Session 1')
  })

  it('Protokoll mit Plan und git-Commit', async () => {
    const runs = (await req('GET', `${V}/runs`)).json.items
    expect(runs[0].status).toBe('done')
    expect(runs[0].commit_sha).toMatch(/^[0-9a-f]{40}$/)
    const run = (await req('GET', `${V}/runs/${runs[0].id}`)).json
    expect(run.plan.length).toBeGreaterThan(5)
    expect(run.extraction.resolutions.length).toBe(EXTRACTION1.entities.length - 1) // Zylia zusammengeführt
    const log = await ctx.services.vaults.get('dnd').git.log(undefined, 3)
    expect(log[0].message).toBe('Kurator: whispernotes:job:ab12cd34 (2026-10-11 Session 1)')
  })

  it('Erneute Verarbeitung derselben Quelle ersetzt statt zu verdoppeln', async () => {
    const zBefore = await byTitle('Zylia', 'npc')
    const r = await req('POST', `${V}/inbox`, SESSION1, { 'idempotency-key': 'whispernotes:job:ab12cd34:v2' })
    expect(r.json.note_id).toBe(inbox1.note_id)
    await ctx.services.jobs.drain()
    const zAfter = await byTitle('Zylia', 'npc')
    expect(zAfter.id).toBe(zBefore.id)
    expect(zAfter.blocks.filter((b: any) => b.key === 'whispernotes:job:ab12cd34')).toHaveLength(1)
    expect(zAfter.body.match(/Bittet die Gruppe/g)).toHaveLength(1)
    const npcs = (await req('GET', `${V}/notes?type=npc&campaign=Tests`)).json.items
    expect(npcs.filter((n: any) => n.title === 'Zylia')).toHaveLength(1)
    // Alter offener Vorschlag derselben Quelle wurde ersetzt
    const open = (await req('GET', `${V}/proposals?status=open`)).json.items.filter((x: any) => x.operation.title === 'Schleimmonster')
    expect(open).toHaveLength(1)
  })

  it('Trockenlauf zeigt nur den Plan mit Diffs', async () => {
    const n = (await req('POST', `${V}/notes`, { type: 'lore', title: 'Notiz zur Karawane', frontmatter: { campaign: 'Tests' }, body: 'Cydia bittet um Hilfe.\n' })).json
    const before = (await byTitle('Zylia', 'npc')).version
    const r = await req('POST', `${V}/notes/${n.id}/curate?dry_run=1`)
    expect(r.json.status).toBe('planned')
    expect(r.json.operations.length).toBeGreaterThan(0)
    expect(r.json.operations.find((o: any) => o.note_title === 'Zylia').diff).toContain('@@')
    expect((await byTitle('Zylia', 'npc')).version).toBe(before)
    const runs = (await req('GET', `${V}/runs`)).json.items
    expect(runs[0].dry_run).toBe(true)
  })

  let run2: string
  it('Zweite Session: Sylvia → Zylia, Valerios → Valerius, Änderungen als Vorschlag', async () => {
    const r = await req('POST', `${V}/inbox`, SESSION2)
    await ctx.services.jobs.drain()
    const ib = (await req('GET', `${V}/inbox/${r.json.inbox_id}`)).json
    expect(ib.status).toBe('processed')
    run2 = ib.run_id
    const session2 = (await req('GET', `${V}/notes/${r.json.note_id}`)).json
    expect(session2.campaign).toBe('Tests')
    expect(session2.frontmatter.number).toBe(2)

    const zylia = await byTitle('Zylia', 'npc')
    expect(zylia.aliases).toEqual(expect.arrayContaining(['Cydia', 'Sylvia']))
    expect(zylia.body).toContain('Wird der Gruppe gegenüber feindselig')
    expect(zylia.frontmatter.attitude).toBe('freundlich') // nicht still überschrieben
    const valerius = await byTitle('Valerius', 'npc')
    expect(valerius.aliases).toContain('Valerios')
    expect((await req('GET', `${V}/notes?type=npc`)).json.items.filter((n: any) => /^Sylvia|^Valerios/.test(n.title))).toHaveLength(0)

    const props = (await req('GET', `${V}/proposals?status=open&run_id=${run2}`)).json.items
    const att = props.find((p: any) => p.kind === 'update_property' && p.operation.field === 'attitude')
    expect(att.operation.to).toBe('feindlich')
    const quest = props.find((p: any) => p.kind === 'update_quest')
    expect(quest.operation.to).toBe('erledigt')

    // Vorschlag mit Diff, anpassen und annehmen
    const detail = (await req('GET', `${V}/proposals/${att.id}`)).json
    expect(detail.diff).toContain('+attitude: feindlich')
    await req('PATCH', `${V}/proposals/${att.id}`, { to: 'neutral' })
    const acc = await req('POST', `${V}/proposals/${att.id}/accept`)
    expect(acc.json.status).toBe('accepted')
    expect((await byTitle('Zylia', 'npc')).frontmatter.attitude).toBe('neutral')
  })

  it('Gesammelt ablehnen', async () => {
    const open = (await req('GET', `${V}/proposals?status=open&run_id=${run2}`)).json.items
    const r = await req('POST', `${V}/proposals/bulk`, { ids: open.map((p: any) => p.id), action: 'reject' })
    expect(r.json.results.every((x: any) => x.status === 'rejected')).toBe(true)
  })

  it('Lauf rückgängig machen', async () => {
    const r = await req('POST', `${V}/runs/${run2}/revert`)
    expect(r.status).toBe(200)
    expect(r.json.revert_commit).toMatch(/^[0-9a-f]{40}$/)
    expect(['git', 'semantic']).toContain(r.json.method)
    const zylia = await byTitle('Zylia', 'npc')
    expect(zylia.aliases).not.toContain('Sylvia')
    expect(zylia.body).not.toContain('feindselig')
    // angenommener Vorschlag (eigener Commit) bleibt
    expect(zylia.frontmatter.attitude).toBe('neutral')
    const again = await req('POST', `${V}/runs/${run2}/revert`)
    expect(again.status).toBe(409)
  })

  it('Kampagnen-Übersicht für das Panel', async () => {
    const o = (await req('GET', `${V}/campaigns/tests/overview?visibility=dm`)).json
    expect(o.campaign.title).toBe('Tests')
    expect(o.sessions.map((s: any) => s.number)).toEqual([2, 1])
    expect(o.last_session.title).toBe('2026-10-18 Session 2')
    expect(o.open_quests.map((q: any) => q.title)).toContain('Brücke über den Bach')
    expect(o.counts.npc).toBeGreaterThanOrEqual(2)
    const first = (await req('GET', `${V}/campaigns/tests/timeline`)).json.items[0]
    expect(first.recap_excerpt).toContain('Die Karawane bricht von Valerius auf.')
    const players = (await req('GET', `${V}/campaigns/tests/overview?visibility=players`)).json
    expect(players.open_proposals).toBe(0)
  })

  it('names als Whisper-Glossar enthält gelernte Varianten', async () => {
    const n = (await req('GET', `${V}/names?campaign=Tests&types=npc,character`)).json
    expect(n.glossary).toEqual(expect.arrayContaining(['Zylia', 'Cydia', 'Lyssara', 'Lusara', 'Valerius']))
  })

  it('LLM bekam Namensliste und JSON-Schema', () => {
    const extraction = llm.calls.find((c) => c.system.startsWith('Du bist der Archivar') && /Sylvia wird/.test(c.user))!
    expect(extraction.system).toMatch(/Zylia \[Cydia\] \(npc\)/)
    expect((extraction.schema as any).properties.entities).toBeTruthy()
  })
})
