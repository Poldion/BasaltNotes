import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeLlm, makeApp } from './helpers.js'

let ctx: Awaited<ReturnType<typeof makeApp>>
let llm: FakeLlm
const V = '/api/v1/vaults/dnd'
const req = async (method: string, url: string, body?: any, headers = ctx.auth) => {
  const r = await ctx.app.inject({ method: method as any, url, payload: body, headers })
  return { status: r.statusCode, json: (() => { try { return r.json() as any } catch { return null } })(), raw: r.payload }
}
const context = async (question: string, extra: any = {}, headers?: any) => (await req('POST', `${V}/chat/context`, { question, ...extra }, headers)).json
const ids: Record<string, string> = {}

beforeAll(async () => {
  llm = new FakeLlm([])
  ctx = await makeApp(llm)
  const mk = async (type: string, title: string, body: string, frontmatter: any = {}) => {
    const n = (await req('POST', `${V}/notes`, { type, title, body, frontmatter })).json
    ids[title] = n.id
  }
  await mk('npc', 'Kefir', '# Kefir\n\n## Beschreibung\n\nEin kleiner Koboldmagier mit grünem Hut. Wohnt in [[Kefirs Turm]].\n\n## Motive (DM)\n\nHasst Gerüche und plant den Verrat.\n', { role: 'Koboldmagier', visibility: 'players' })
  await mk('location', 'Kefirs Turm', '# Kefirs Turm\n\nSchiefer Turm am Moor, riecht nach Schwefel.\n', { visibility: 'players' })
  await mk('quest', 'Muffgallerte jagen', '# Muffgallerte jagen\n\nDie Muffgallerte aus dem Keller vertreiben.\n', { status: 'offen', giver: '[[Kefir]]' })
  await mk('quest', 'Eberjagd', '# Eberjagd\n\nDen Eber im Wald erlegen.\n', { status: 'erledigt' })
  await mk('session', 'Session 3', '# Session 3\n\nDie Gruppe traf [[Kefir]] im Turm. Er verlangte 50 Gold für den Trank.\n', { number: 3, visibility: 'players' })
  await mk('npc', 'Fyrn Linstök', '# Fyrn Linstök\n\nKarawanenführer aus dem Süden.\n')
  await mk('npc', 'Bäcker Hold', '# Bäcker Hold\n\nBackt Brot in der Unterstadt.\n')
})
afterAll(async () => ctx?.cleanup())

describe('Chat: Vorauswahl ohne LLM', () => {
  it('findet die genannte Person samt Eigenschaften, Erwähnungen und Verknüpfungen – sonst nichts', async () => {
    const c = await context('Was weiß ich über Kefir?')
    expect(c.focus).toEqual([ids['Kefir']])
    expect(c.text).toContain('## Kefir (NPC)')
    expect(c.text).toContain('Rolle: Koboldmagier')
    expect(c.text).toContain('Hasst Gerüche') // DM-Sicht
    expect(c.text).toContain('verlangte 50 Gold') // Erwähnung in Session 3
    expect(c.text).toContain('Kefirs Turm') // verknüpft
    expect(c.text).not.toContain('Brot')
    expect(c.text).not.toMatch(/basalt:block|\[\[/)
    const roles = Object.fromEntries(c.sources.map((s: any) => [s.title, s.role]))
    expect(roles).toMatchObject({ Kefir: 'focus', 'Session 3': 'mention', 'Kefirs Turm': 'related' })
    expect(c.chars).toBeLessThanOrEqual(c.budget)
  })

  it('erkennt gebeugte Namen, Teilnamen und Tippfehler', async () => {
    expect((await context('Wo steht Kefirs Turm?')).focus[0]).toBe(ids['Kefirs Turm'])
    expect((await context('wer ist fyrn eigentlich')).focus).toEqual([ids['Fyrn Linstök']])
    expect((await context('Was war mit der Muffelgallerte?')).focus).toEqual([ids['Muffgallerte jagen']])
  })

  it('beantwortet Übersichtsfragen mit einer Liste des Typs, gefiltert nach Status', async () => {
    const c = await context('Welche Quests sind offen?')
    expect(c.list_types).toEqual(['quest'])
    expect(c.text).toContain('Muffgallerte jagen')
    expect(c.text).not.toContain('Eberjagd')
  })

  it('Rückfragen beziehen sich auf das vorige Thema', async () => {
    const c = await context('Und was will er?', { previous: [ids['Kefir']] })
    expect(c.focus).toEqual([ids['Kefir']])
  })

  it('Volltext findet Einträge, in denen nur ein Begriff vorkommt', async () => {
    const c = await context('Wo riecht es nach Schwefel?')
    expect(c.sources.map((s: any) => s.title)).toContain('Kefirs Turm')
  })

  it('Spieler-Sicht: keine DM-Abschnitte und keine DM-Einträge', async () => {
    const tok = ctx.services.auth.createToken({ name: 'spieler-chat', vaults: ['dnd'], scopes: ['read'], visibility: 'players' })
    const h = { authorization: `Bearer ${tok.token}` }
    const c = await context('Was weiß ich über Kefir?', {}, h)
    expect(c.text).toContain('Koboldmagier')
    expect(c.text).not.toContain('Hasst Gerüche')
    const q = await context('Welche Quests gibt es?', {}, h)
    expect(q.text).not.toContain('Muffgallerte')
  })
})

describe('Chat: Antwort', () => {
  it('schickt nur den Kontext an das LLM und liefert Quellen', async () => {
    llm.textCalls = []
    const r = (await req('POST', `${V}/chat`, { question: 'Was weiß ich über Kefir?' })).json
    expect(r.answer).toContain('Koboldmagier')
    expect(r.llm).toBe(true)
    expect(r.sources.some((s: any) => s.title === 'Kefir')).toBe(true)
    const call = llm.textCalls[0]
    const last = call.messages.at(-1)!.content
    expect(last).toMatch(/^NOTIZEN:/)
    expect(last).toContain('FRAGE: Was weiß ich über Kefir?')
    expect(last).not.toContain('Brot')
  })

  it('ohne passende Notizen wird das LLM gar nicht gefragt', async () => {
    llm.textCalls = []
    const r = (await req('POST', `${V}/chat`, { question: 'Wie wird das Wetter in Paris?' })).json
    expect(r.llm).toBe(false)
    expect(r.answer).toMatch(/nichts gefunden/)
    expect(llm.textCalls).toHaveLength(0)
  })

  it('streamt als Server-Sent Events', async () => {
    const r = await req('POST', `${V}/chat`, { question: 'Wer ist Kefir?', stream: true })
    expect(r.raw).toContain('event: context')
    expect(r.raw).toContain('event: start')
    expect(r.raw).toContain('event: token')
    expect(r.raw).toContain('event: done')
  })
})

describe('Chat: Stand und Verlauf', () => {
  it('ordnet Sessions zeitlich und gibt die neueste ausführlich mit; Skripte nur als Vorbereitung', async () => {
    const mk = (type: string, title: string, body: string, frontmatter: any = {}) => req('POST', `${V}/notes`, { type, title, body, frontmatter })
    // Reihenfolge = Reihenfolge des Hochladens; Nummern spielen keine Rolle
    await mk('session', 'Session 4', '# Session 4\n\n## Ereignisse\n\nRettung im Dorf Olibers Fleck.\n', { number: 9 })
    await new Promise((r) => setTimeout(r, 1100))
    await mk('session', 'Session 5', '# Session 5\n\n## Was bisher geschah\n\nDie Gruppe verließ das Dorf.\n\n## Ereignisse\n\nAnkunft vor den Toren von Stahlheim.\n\n## Offene Handlungsstränge\n\n- Eindringen in Stahlheim\n', { number: 1 })
    await mk('script', 'Teil 6 Vorbereitung', '# Teil 6\n\nDie Gruppe findet den Erben.\n', { status: 'geplant' })
    const c = await context('Was ist der aktuelle Stand der Kampagne?')
    expect(c.timeline).toBe(true)
    expect(c.list_types).toEqual([])
    const iOld = c.text.indexOf('Session 4')
    const iNew = c.text.indexOf('Session 5')
    expect(iOld).toBeGreaterThan(-1)
    expect(iOld).toBeLessThan(iNew)
    expect(c.text).toMatch(/Neueste Session \(aktueller Stand\): Session 5/)
    expect(c.text).toContain('Ankunft vor den Toren von Stahlheim')
    expect(c.text).toMatch(/Teil 6 Vorbereitung \(Vorbereitung, geplant\)/)
    expect(c.text).not.toContain('Die Gruppe findet den Erben')
  })

  it('Rückfrage ohne eigenes Thema liest die vorige Frage mit', async () => {
    const c = await context('Nee, das kann nicht sein', { history: [{ role: 'user', content: 'Was ist der aktuelle Stand?' }, { role: 'assistant', content: 'Sie sind im Dorf.' }] })
    expect(c.timeline).toBe(true)
    expect(c.text).toContain('Session 5')
  })

  it('„letzte Session“ ist kein Name', async () => {
    const c = await context('Was ist in der letzten Session passiert?')
    expect(c.timeline).toBe(true)
    expect(c.focus).toEqual([])
  })

  it('schickt dem LLM den Hinweis auf die zeitliche Ordnung', async () => {
    llm.textCalls = []
    await req('POST', `${V}/chat`, { question: 'Was ist zuletzt passiert?' })
    expect(llm.textCalls[0].system).toMatch(/NEUESTEN Session/)
  })
})

describe('Chat: offene Punkte mit heutigem Stand abgleichen', () => {
  it('hängt Quest-Status und passende Ereignisse an, abgehakte Punkte gelten als erledigt', async () => {
    const { annotateOpenThreads } = await import('../src/chat/chat.js')
    const text = [
      '## Ereignisse',
      '- Übergabe von Murks an den Wirt und Verlassen der Taverne.',
      '- Gespräch über eine verschollene Sekte.',
      '',
      '## Offene Handlungsstränge',
      '- [ ] Entscheidung des Wirts bezüglich Murks.',
      '- [ ] Untersuchung des Schmugglerverstecks (Höhle).',
      '- [ ] Eindringen in Stahlheim und Umgang mit den Wachen.',
      '- [x] Ratten vertreiben.',
      '- [ ] Was ist die Identität der verschollenen Sekte?',
    ].join('\n')
    const out = annotateOpenThreads(text, [
      { title: 'Untersuchung des Schmugglerverstecks (Höhle)', status: 'erledigt' },
      { title: 'Eindringen in Stahlheim', status: 'offen' },
    ])
    expect(out).toContain('Entscheidung des Wirts bezüglich Murks. → laut Ereignissen bereits geschehen')
    expect(out).toContain('(Höhle). → Quest „Untersuchung des Schmugglerverstecks (Höhle)“: erledigt')
    expect(out).toContain('Wachen. → Quest „Eindringen in Stahlheim“: offen')
    expect(out).toContain('Ratten vertreiben. → erledigt (abgehakt)')
    expect(out).toMatch(/verschollenen Sekte\?$/m)
  })

  it('Stand-Fragen bekommen den aktuellen Quest-Status', async () => {
    const c = await context('Was müssen sie als nächstes tun?')
    expect(c.timeline).toBe(true)
    expect(c.text).toMatch(/Quests – aktueller Status/)
    expect(c.text).toMatch(/Erledigt\/abgeschlossen: .*Eberjagd \(erledigt\)/)
  })
})
