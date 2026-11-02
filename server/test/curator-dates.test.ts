import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eventsFromText, normalizeDateValue, parseDate } from '../src/curator/dates.js'
import { FakeLlm, makeApp } from './helpers.js'

const TODAY = '2026-11-02'

describe('Datumsangaben', () => {
  it.each([
    ['Di, 03.11.2026', '2026-11-03', null],
    ['03.11.2026 14:30', '2026-11-03', '14:30'],
    ['3.11.26 um 9 Uhr', '2026-11-03', '09:00'],
    ['2026-11-03T14:00:00+01:00', '2026-11-03', '14:00'],
    ['3. November 2026', '2026-11-03', null],
    ['05.01.', '2027-01-05', null],
    ['1. März', '2027-03-01', null],
  ])('%s', (text, date, time) => {
    expect(parseDate(text, TODAY)).toMatchObject({ date, time })
  })

  it('Unsinn und Daten einer Spielwelt bleiben unverändert', () => {
    expect(parseDate('31.02.2026', TODAY)).toBeNull()
    expect(normalizeDateValue('12. Mirtul', 'date', TODAY)).toBe('12. Mirtul')
    expect(normalizeDateValue('nächste Woche', 'datetime', TODAY)).toBe('nächste Woche')
  })

  it('Datumsfeld ohne Uhrzeit bekommt keine, Datum-und-Zeit-Feld schon', () => {
    expect(normalizeDateValue('03.11.2026 14:00', 'date', TODAY)).toBe('2026-11-03')
    expect(normalizeDateValue('03.11.2026 14:00', 'datetime', TODAY)).toBe('2026-11-03T14:00')
  })

  it('Liest den Abschnitt „Termine“ eines Protokolls', () => {
    const text = '## Zusammenfassung\n- Am 01.12.2026 war nichts\n\n## Termine\n- **Di, 03.11.2026** — Ein Termin mit dem Ministerium NRW.\n- 05.11.2026 14:30 Uhr: Abgabe\n- Keine weiteren\n\n## Entscheidungen\n- 09.11.2026 beschlossen'
    expect(eventsFromText(text, TODAY)).toEqual([
      { title: 'Ein Termin mit dem Ministerium NRW', line: 'Di, 03.11.2026 — Ein Termin mit dem Ministerium NRW.', start: '2026-11-03' },
      { title: 'Abgabe', line: '05.11.2026 14:30 Uhr: Abgabe', start: '2026-11-05T14:30' },
    ])
  })
})

describe('Kurator legt Termine für den Kalender an', () => {
  const V = '/api/v1/vaults/alltag'
  let ctx: Awaited<ReturnType<typeof makeApp>>
  const req = async (method: string, url: string, body?: any) => {
    const r = await ctx.app.inject({ method: method as any, url, payload: body, headers: ctx.auth })
    return { status: r.statusCode, json: r.json() as any }
  }
  const curate = async (key: string, content: string) => {
    const r = await req('POST', `${V}/inbox`, { source_key: key, text: content, curate: 'auto' })
    expect(r.status).toBeLessThan(300)
    for (let i = 0; i < 100; i++) {
      const st = (await req('GET', `${V}/curator/status`)).json
      if (!st.running.length && !st.queued) return
      await new Promise((res) => setTimeout(res, 50))
    }
    throw new Error('Kurator wird nicht fertig')
  }
  const events = async () => (await req('GET', `${V}/notes?type=event&limit=50&fields=title,type,path,frontmatter`)).json.items

  beforeAll(async () => {
    const entity = (name: string, start?: string, facts: string[] = []) => ({ name, type: 'event', mentioned_as: [], summary: '', facts, visibility: 'players', confidence: 0.95, properties: start ? { start } : {} })
    ctx = await makeApp(
      new FakeLlm([
        { match: /Textform/, result: { entities: [entity('Zahnarzt', 'Di, 03.11.2026 um 14:30')], events: [], quests: [], facts: [], relations: [] } },
        { match: /Nur Fakten/, result: { entities: [entity('Steuerberater', undefined, ['Findet am 10.11.2026 statt'])], events: [], quests: [], facts: [], relations: [] } },
        { match: /Doppelt/, result: { entities: [entity('Kundentermin', '2026-11-20')], events: [], quests: [], facts: [], relations: [] } },
      ]),
    )
    expect((await req('POST', '/api/v1/vaults', { name: 'Alltag', preset: 'notes' })).status).toBe(201)
  })
  afterAll(async () => ctx?.cleanup())

  const startOf = async (title: string) => {
    const n = (await events()).find((x: any) => x.title === title)
    expect(n, title).toBeTruthy()
    return (await req('GET', `${V}/notes/${n.id}`)).json.frontmatter.start
  }

  it('Datum in Textform wird vereinheitlicht', async () => {
    await curate('a', 'Textform: Zahnarzt am Dienstag')
    expect(String(await startOf('Zahnarzt'))).toContain('2026-11-03T14:30')
  })

  it('Fehlender Beginn kommt aus den Fakten', async () => {
    await curate('b', 'Nur Fakten vom Steuerberater')
    expect(String(await startOf('Steuerberater'))).toContain('2026-11-10')
  })

  it('Termin nur im Abschnitt „Termine“: wird auch ohne Erkennung durch das LLM angelegt', async () => {
    await curate('c', '## Zusammenfassung\nBesprechung.\n\n## Termine\n- **Di, 17.11.2026** — Termin beim Ministerium NRW')
    expect(String(await startOf('Termin beim Ministerium NRW'))).toContain('2026-11-17')
  })

  it('Vom LLM erkannter Termin wird nicht doppelt angelegt', async () => {
    await curate('d', 'Doppelt\n\n## Termine\n- 20.11.2026 Kundentermin bei Müller')
    const titles = (await events()).map((x: any) => x.title)
    expect(titles).toContain('Kundentermin')
    expect(titles).not.toContain('Kundentermin bei Müller')
  })

  it('Gleicher Name an einem anderen Tag ist ein neuer Termin, der alte bleibt unverändert', async () => {
    await curate('e', 'Noch ein Termin\n\n## Termine\n- 24.11.2026 Zahnarzt')
    const same = (await events()).filter((x: any) => x.title.startsWith('Zahnarzt'))
    expect(same).toHaveLength(2)
    const starts = await Promise.all(same.map(async (n: any) => String((await req('GET', `${V}/notes/${n.id}`)).json.frontmatter.start)))
    expect(starts.some((s) => s.includes('2026-11-03T14:30'))).toBe(true)
    expect(starts.some((s) => s.includes('2026-11-24'))).toBe(true)
  })
})
