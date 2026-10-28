import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeLlm, makeApp } from './helpers.js'

let ctx: Awaited<ReturnType<typeof makeApp>>
const N = '/api/v1/vaults/leben'
const D = '/api/v1/vaults/dnd'
const req = async (method: string, url: string, body?: any, headers: Record<string, string> = ctx.auth) => {
  const r = await ctx.app.inject({ method: method as any, url, payload: body, headers })
  return { status: r.statusCode, json: r.json() as any }
}
const mk = (vault: string, type: string, title: string, frontmatter: any) => req('POST', `${vault}/notes`, { type, title, frontmatter })
const cal = async (url: string, headers?: Record<string, string>) => (await req('GET', url, undefined, headers)).json

beforeAll(async () => {
  ctx = await makeApp(new FakeLlm([]))
  await req('POST', '/api/v1/vaults', { name: 'Leben', id: 'leben', preset: 'notes' })
  await mk(N, 'event', 'Zahnarzt', { start: '2026-11-03T09:30:00+01:00', end: '2026-11-03T10:15:00+01:00', location: 'Praxis Dr. Weiß' })
  await mk(N, 'event', 'Urlaub', { start: '2026-11-20', end: '2026-11-24', all_day: true })
  await mk(N, 'event', 'Sport', { start: '2026-11-02T18:00:00+01:00', recurrence: 'wöchentlich', until: '2026-11-23' })
  await mk(N, 'event', 'Monatsende', { start: '2026-10-31', recurrence: 'monatlich' })
  await mk(N, 'task', 'Steuer', { due: '2026-11-10', status: 'offen' })
  await mk(N, 'task', 'Altpapier', { due: '2026-11-05T07:00:00+01:00', status: 'erledigt' })
  await mk(N, 'note', 'Ohne Datum', {})
  await mk(D, 'session', 'Session 4', { date: '2026-11-07T19:00:00+01:00', campaign: 'Regarion' })
  await mk(D, 'script', 'Teil 3', { planned_for: '2026-11-14', campaign: 'Curse of Strahd' })
})
afterAll(async () => ctx?.cleanup())

describe('Kalender', () => {
  it('liefert Termine, Aufgaben und Wiederholungen im Zeitraum', async () => {
    const r = await cal(`${N}/calendar?from=2026-11-01&to=2026-11-30`)
    const by = (t: string) => r.items.filter((i: any) => i.title === t)
    expect(by('Zahnarzt')[0]).toMatchObject({ start: '2026-11-03T09:30', end: '2026-11-03T10:15', all_day: false, location: 'Praxis Dr. Weiß', field: 'start' })
    expect(by('Urlaub')[0]).toMatchObject({ start: '2026-11-20', end: '2026-11-24', all_day: true })
    expect(by('Sport').map((i: any) => i.start)).toEqual(['2026-11-02T18:00', '2026-11-09T18:00', '2026-11-16T18:00', '2026-11-23T18:00'])
    expect(by('Sport')[1].id).toMatch(/@2026-11-09$/)
    expect(by('Monatsende')).toHaveLength(0) // 31.11. gibt es nicht
    expect(by('Steuer')[0]).toMatchObject({ start: '2026-11-10', all_day: true, done: false, field: 'due' })
    expect(by('Altpapier')[0]).toMatchObject({ start: '2026-11-05T07:00', done: true })
    expect(by('Ohne Datum')).toHaveLength(0)
    expect(r.items.map((i: any) => i.start)).toEqual([...r.items.map((i: any) => i.start)].sort())
  })

  it('mehrtägige Termine erscheinen, wenn sie in den Zeitraum hineinragen', async () => {
    const r = await cal(`${N}/calendar?from=2026-11-22&to=2026-11-22`)
    expect(r.items.map((i: any) => i.title)).toContain('Urlaub')
    const dec = await cal(`${N}/calendar?from=2026-12-01&to=2026-12-31`)
    expect(dec.items.map((i: any) => i.start)).toContain('2026-12-31')
  })

  it('nimmt Sessions und Vorbereitungen aus D&D-Vaults und vereint alle Notizbücher', async () => {
    const d = await cal(`${D}/calendar?from=2026-11-01&to=2026-11-30`)
    expect(d.items.map((i: any) => [i.title, i.field])).toEqual([
      ['Session 4', 'date'],
      ['Teil 3', 'planned_for'],
    ])
    const all = await cal('/api/v1/calendar?from=2026-11-01&to=2026-11-30')
    expect(new Set(all.items.map((i: any) => i.vault))).toEqual(new Set(['leben', 'dnd']))
  })

  it('beachtet Freigaben und prüft Eingaben', async () => {
    const tok = (await req('POST', '/api/v1/tokens', { name: 'ha', grants: [{ vault: 'dnd', access: 'read', campaign: 'Regarion', shared: false }] })).json.token
    const h = { authorization: `Bearer ${tok}` }
    const all = await cal('/api/v1/calendar?from=2026-11-01&to=2026-11-30', h)
    expect(all.items.map((i: any) => i.title)).toEqual(['Session 4'])
    expect((await req('GET', `${N}/calendar`, undefined, h)).status).toBe(403)
    expect((await req('GET', `${N}/calendar?from=2026-13-01`)).status).toBe(400)
    expect((await req('GET', `${N}/calendar?from=2026-01-01&to=2027-12-31`)).status).toBe(400)
  })
})
