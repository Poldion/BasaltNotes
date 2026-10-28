import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { linkMentions } from '../src/curator/linker.js'
import { FakeLlm, makeApp } from './helpers.js'

let ctx: Awaited<ReturnType<typeof makeApp>>
let llm: FakeLlm
let apfel: any
const F = '/api/v1/vaults/frei'
const req = async (method: string, url: string, body?: any) => {
  const r = await ctx.app.inject({ method: method as any, url, payload: body, headers: ctx.auth })
  return { status: r.statusCode, json: r.json() as any }
}
async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (ok(v) || Date.now() > end) return v
    await new Promise((r) => setTimeout(r, 30))
  }
}

beforeAll(async () => {
  llm = new FakeLlm([])
  ctx = await makeApp(llm)
})
afterAll(async () => ctx?.cleanup())

describe('Verknüpfen (ohne LLM)', () => {
  const targets = [
    { title: 'Anna Schmidt', names: ['Anna Schmidt', 'Anna'] },
    { title: 'Projekt Apfel', names: ['Projekt Apfel'] },
    { title: 'Rom', names: ['Rom'] },
    { title: 'Max', names: ['Max'] },
    { title: 'Max Müller', names: ['Max'] },
    { title: '2026-10-28', names: ['2026-10-28'] },
  ]

  it('verlinkt die erste Erwähnung, längere Namen zuerst, mit Anzeigetext bei Aliassen', () => {
    const r = linkMentions('Mit anna über projekt apfel gesprochen. Anna Schmidt kommt auch.', targets)
    expect(r.body).toBe('Mit anna über [[Projekt Apfel|projekt apfel]] gesprochen. [[Anna Schmidt]] kommt auch.')
    expect(r.linked).toEqual(['Projekt Apfel', 'Anna Schmidt'])
  })

  it('kurze Namen nur in exakter Schreibweise, ganze Wörter, keine mehrdeutigen Namen, keine Daten', () => {
    expect(linkMentions('Nach rom und Romantik, dann Rom.', targets).body).toBe('Nach rom und Romantik, dann [[Rom]].')
    expect(linkMentions('Max kommt am 2026-10-28.', targets).linked).toEqual([])
  })

  it('lässt Code, Links, URLs, Überschriften und schon verlinkte Ziele in Ruhe', () => {
    const body = '# Anna\n\n`Anna` und [Anna](https://x.de/Anna) und [[Projekt Apfel]] und https://anna.de\n\nProjekt Apfel'
    const r = linkMentions(body, targets, new Set(['projekt apfel']))
    expect(r.linked).toEqual([])
    expect(r.body).toBe(body)
    expect(linkMentions('```\nAnna\n```\nAnna', targets).body).toBe('```\nAnna\n```\n[[Anna Schmidt|Anna]]')
  })
})

describe('Freier Vault', () => {
  it('anlegen: nur „Notiz“, Kurator im Modus „nur verknüpfen“', async () => {
    const v = await req('POST', '/api/v1/vaults', { name: 'Frei', preset: 'empty' })
    expect(v.status).toBe(201)
    expect(v.json.types).toEqual(['note'])
    expect(v.json.curator).toMatchObject({ enabled: true, mode: 'link' })
  })

  it('Ordner frei wählbar', async () => {
    const n = await req('POST', `${F}/notes`, { title: 'Anna Schmidt', folder: 'Leute/Familie', frontmatter: { aliases: ['Anna'] } })
    expect(n.json.path).toBe('Leute/Familie/Anna Schmidt.md')
    apfel = (await req('POST', `${F}/notes`, { title: 'Projekt Apfel' })).json
    expect(apfel.path).toBe('Projekt Apfel.md')
  })

  it('„Erwähnungen verknüpfen“: Vorschau, Übernehmen, danach nichts mehr', async () => {
    const n = await req('POST', `${F}/notes`, { title: 'Treffen', body: '# Treffen\n\nMit Anna über Projekt Apfel gesprochen.\n' })
    const dry = await req('POST', `${F}/notes/${n.json.id}/link`, { dry_run: true })
    expect(dry.json.linked).toEqual(['Anna Schmidt', 'Projekt Apfel'])
    expect(dry.json.diff).toMatch(/\+Mit \[\[Anna Schmidt\|Anna\]\] über \[\[Projekt Apfel\]\]/)
    expect((await req('GET', `${F}/notes/${n.json.id}`)).json.body).not.toMatch(/\[\[/)

    const r = await req('POST', `${F}/notes/${n.json.id}/link`, { links: ['Projekt Apfel'] })
    expect(r.json.linked).toEqual(['Projekt Apfel'])
    expect(r.json.note.body).toMatch(/Mit Anna über \[\[Projekt Apfel\]\]/)
    // Rückverweis entsteht automatisch über den Index
    expect(JSON.stringify((await req('GET', `${F}/notes/${apfel.id}/backlinks`)).json)).toMatch(/Treffen/)

    await req('POST', `${F}/notes/${n.json.id}/link`, {})
    expect((await req('POST', `${F}/notes/${n.json.id}/link`, { dry_run: true })).json.linked).toEqual([])
  })

  it('Eingang: Kurator verknüpft nur – kein LLM, nichts angelegt', async () => {
    const before = (await req('GET', `${F}/notes?limit=100`)).json.items.length
    const ib = await req('POST', `${F}/inbox`, { note: { title: 'Sprachnotiz', body: 'Anna fragt, wie es mit Projekt Apfel weitergeht. Bernd kommt auch.' } })
    expect(ib.status).toBe(202)
    const done = await waitFor(() => req('GET', `${F}/inbox/${ib.json.inbox_id}`).then((x) => x.json), (i) => ['processed', 'error'].includes(i.status))
    expect(done.status).toBe('processed')
    const note = (await req('GET', `${F}/notes/${ib.json.note_id}`)).json
    expect(note.body).toMatch(/\[\[Anna Schmidt\|Anna\]\] fragt, wie es mit \[\[Projekt Apfel\]\] weitergeht\. Bernd/)
    expect((await req('GET', `${F}/notes?limit=100`)).json.items.length).toBe(before + 1)
    expect(llm.calls).toHaveLength(0)
  })

  it('Kalender erkennt Datumsfelder im Kopf freier Notizen', async () => {
    await req('POST', `${F}/notes`, { title: 'Zahnarzt', frontmatter: { start: '2026-11-03T10:00', end: '2026-11-03T11:00' } })
    await req('POST', `${F}/notes`, { title: 'Steuer', frontmatter: { due: '2026-11-10' } })
    const cal = await req('GET', `${F}/calendar?from=2026-11-01&to=2026-11-30`)
    expect(cal.status).toBe(200)
    expect(cal.json.items.map((i: any) => [i.title, i.start, i.field])).toEqual([
      ['Zahnarzt', '2026-11-03T10:00', 'start'],
      ['Steuer', '2026-11-10', 'due'],
    ])
  })

  it('Kurator-Modus umschalten', async () => {
    expect((await req('PATCH', F, { curator: { mode: 'quatsch' } })).status).toBe(400)
    expect((await req('PATCH', F, { curator: { mode: 'full' } })).json.curator.mode).toBe('full')
    expect((await req('PATCH', F, { curator: { enabled: false } })).json.curator).toMatchObject({ enabled: false, mode: 'full' })
  })
})

describe('Freier Vault ohne KI-Funktionen', () => {
  it('Eingang verknüpft trotzdem, ein Vault mit „Einsortieren (KI)“ legt nur ab', async () => {
    const off = await makeApp(new FakeLlm([]), { config: { features: { curator: false, chat: false, setup_done: true } } })
    const r = async (method: string, url: string, body?: any) => (await off.app.inject({ method: method as any, url, payload: body, headers: off.auth })).json() as any
    try {
      await r('POST', '/api/v1/vaults', { name: 'Ohne KI', preset: 'empty' })
      const O = '/api/v1/vaults/ohne-ki'
      await r('POST', `${O}/notes`, { title: 'Projekt Apfel' })
      const ib = await r('POST', `${O}/inbox`, { note: { title: 'Notiz', body: 'Wie läuft Projekt Apfel?' } })
      expect(ib.status).toBe('queued')
      const done = await waitFor(() => r('GET', `${O}/inbox/${ib.inbox_id}`), (i) => ['processed', 'error'].includes(i.status))
      expect(done.status).toBe('processed')
      expect((await r('GET', `${O}/notes/${ib.note_id}`)).body).toMatch(/\[\[Projekt Apfel\]\]/)

      expect((await r('POST', '/api/v1/vaults/dnd/inbox', { note: { title: 'Session 1', body: 'Kefir.' } })).status).toBe('stored')
    } finally {
      await off.cleanup()
    }
  })
})
