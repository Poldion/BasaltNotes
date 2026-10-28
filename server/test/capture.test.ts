import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeLlm, makeApp } from './helpers.js'

let ctx: Awaited<ReturnType<typeof makeApp>>
const N = '/api/v1/vaults/leben'
const req = async (method: string, url: string, body?: any, headers: Record<string, string> = ctx.auth) => {
  const r = await ctx.app.inject({ method: method as any, url, payload: body, headers })
  let json: any = null
  try {
    json = r.json()
  } catch {
    json = null
  }
  return { status: r.statusCode, json, raw: r.payload }
}

beforeAll(async () => {
  ctx = await makeApp(new FakeLlm([]))
  await req('POST', '/api/v1/vaults', { name: 'Leben', id: 'leben', preset: 'notes' })
  await req('POST', `${N}/notes`, { type: 'list', title: 'Einkauf', body: '# Einkauf\n\n- [ ] Milch\n\nUnten.\n' })
})
afterAll(async () => ctx?.cleanup())

describe('Schnell erfassen (z. B. aus Home Assistant)', () => {
  it('schreibt ohne Ziel ins heutige Tagebuch, mit Uhrzeit unter „Heute“', async () => {
    const a = await req('POST', `${N}/capture`, { text: 'Heizung entlüftet' })
    expect(a.status).toBe(200)
    expect(a.json.to).toBe('journal')
    await req('POST', `${N}/capture`, { text: 'Paket abgeholt' })
    const note = (await req('GET', `${N}/notes/${a.json.note_id}`)).json
    expect(note.type).toBe('journal')
    expect(note.body).toMatch(/## Heute\n- \d{2}:\d{2} Heizung entlüftet\n- \d{2}:\d{2} Paket abgeholt\n/)
  })

  it('setzt Punkte auf eine Liste (auch mit leicht anderem Namen) und legt Notizen an', async () => {
    const r = await req('POST', `${N}/capture`, { text: 'Eier', list: 'einkauf' })
    expect(r.json).toMatchObject({ to: 'list', title: 'Einkauf' })
    expect((await req('GET', `${N}/notes/${r.json.note_id}`)).json.body).toBe('# Einkauf\n\n- [ ] Milch\n- [ ] Eier\n\nUnten.\n')
    expect((await req('POST', `${N}/capture`, { text: 'x', list: 'Baumarkt' })).status).toBe(404)
    const n = await req('POST', `${N}/capture`, { to: 'note', text: 'Idee: Kräuterbeet am Balkon\n\nMit Basilikum.' })
    expect(n.status).toBe(201)
    expect(n.json.title).toBe('Idee: Kräuterbeet am Balkon')
  })

  it('nur-lesen darf nicht erfassen', async () => {
    const tok = (await req('POST', '/api/v1/tokens', { name: 'ro', grants: [{ vault: 'leben', access: 'read' }] })).json.token
    expect((await req('POST', `${N}/capture`, { text: 'x' }, { authorization: `Bearer ${tok}` })).status).toBe(403)
  })

  it('Markdown für Dashboards: ohne Frontmatter, Markierungen und [[ ]]', async () => {
    const n = (await req('POST', `${N}/notes`, { title: 'Wochenplan', body: '# Wochenplan\n\n- Mo: [[Sport]]\n- Di: [[Einkauf|Einkaufen]]\n\n<!-- basalt:block key="x" -->\nKurator\n<!-- /basalt:block -->\n' })).json
    const md = (await req('GET', `${N}/notes/${n.id}?format=markdown&clean=1`)).raw
    expect(md).toBe('# Wochenplan\n\n- Mo: Sport\n- Di: Einkaufen\n\nKurator\n')
    const j = (await req('GET', `${N}/notes/by-title?title=Wochenplan&fields=title,body&clean=1`)).json
    expect(j).toEqual({ id: n.id, title: 'Wochenplan', body: md })
  })
})
