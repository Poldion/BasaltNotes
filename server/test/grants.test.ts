import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeLlm, makeApp } from './helpers.js'

let ctx: Awaited<ReturnType<typeof makeApp>>
const V = '/api/v1/vaults/dnd'
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
const ids: Record<string, string> = {}
const token = async (grants: any[]) => {
  const r = await req('POST', '/api/v1/tokens', { name: 'tool', grants })
  expect(r.status).toBe(201)
  return { authorization: `Bearer ${r.json.token}` }
}
const titles = (items: any[]) => items.map((i: any) => i.title).sort()

beforeAll(async () => {
  ctx = await makeApp(new FakeLlm([]))
  await req('POST', '/api/v1/vaults', { name: 'Notizen', id: 'notizen', preset: 'notes' })
  const mk = async (type: string, title: string, body: string, frontmatter: any = {}) => {
    const n = (await req('POST', `${V}/notes`, { type, title, body, frontmatter })).json
    ids[title] = n.id
  }
  await mk('lore', 'Chronik von Regarion', '# Chronik\n\nDer Drache [[Xal]] herrscht im Moor. ![[Geheimplan]]\n', { campaign: 'Regarion' })
  await mk('npc', 'Kefir', '# Kefir\n\nKoboldmagier, kennt [[Geheimplan]].\n', { campaign: 'Regarion' })
  await mk('npc', 'Xal', '# Xal\n\nSchwarzer Drache.\n', { campaign: 'Regarion' })
  await mk('note', 'Geheimplan', '# Geheimplan\n\nDer DM plant den Verrat im Moor.\n', { campaign: 'Regarion' })
  await mk('npc', 'Strahd', '# Strahd\n\nVampir im Moor von Barovia.\n', { campaign: 'Curse of Strahd' })
  await mk('lore', 'Götter der Welt', '# Götter\n\nAllgemeine Lore ohne Kampagne, auch im Moor bekannt.\n')
})
afterAll(async () => ctx?.cleanup())

describe('Freigabe: lesen, Kampagne Regarion, nur Lore + NPCs', () => {
  let h: Record<string, string>
  beforeAll(async () => {
    h = await token([{ vault: 'dnd', access: 'read', campaign: 'Regarion', types: ['lore', 'npc'] }])
  })

  it('Liste, Suche, Abfrage, Namen, Graph zeigen nur den Bereich (inkl. Lore ohne Kampagne)', async () => {
    const expected = ['Chronik von Regarion', 'Götter der Welt', 'Kefir', 'Xal']
    expect(titles((await req('GET', `${V}/notes?limit=100`, undefined, h)).json.items)).toEqual(expected)
    expect(titles((await req('GET', `${V}/search?q=Moor`, undefined, h)).json.items)).toEqual(['Chronik von Regarion', 'Götter der Welt'])
    expect(titles((await req('POST', `${V}/query`, { where: [] }, h)).json.items)).toEqual(expected)
    expect((await req('GET', `${V}/names`, undefined, h)).json.items.map((n: any) => n.name).sort()).toEqual(expected)
    expect(titles((await req('GET', `${V}/graph`, undefined, h)).json.nodes)).toEqual(expected)
    expect((await req('GET', `${V}/resolve?name=Strahd`, undefined, h)).json.items).toEqual([])
  })

  it('Notizen außerhalb sind „nicht gefunden“ – per ID, Titel und Pfad', async () => {
    expect((await req('GET', `${V}/notes/${ids['Strahd']}`, undefined, h)).status).toBe(404)
    expect((await req('GET', `${V}/notes/${ids['Geheimplan']}`, undefined, h)).status).toBe(404)
    expect((await req('GET', `${V}/notes/by-title?title=Geheimplan`, undefined, h)).status).toBe(404)
    expect((await req('GET', `${V}/notes/by-title?title=Kefir`, undefined, h)).json.title).toBe('Kefir')
  })

  it('Links und Einbettungen auf Notizen außerhalb verraten nichts', async () => {
    const kefir = (await req('GET', `${V}/notes/${ids['Kefir']}`, undefined, h)).json
    expect(kefir.links.find((l: any) => l.target === 'Geheimplan')).toMatchObject({ target_id: null, resolved: false })
    const html = (await req('GET', `${V}/notes/${ids['Chronik von Regarion']}/html`, undefined, h)).raw
    expect(html).not.toContain('Verrat')
    expect(html).toContain('Xal')
    const bl = (await req('GET', `${V}/notes/${ids['Xal']}/backlinks`, undefined, h)).json.items
    expect(bl.map((b: any) => b.source_title)).toEqual(['Chronik von Regarion'])
  })

  it('Kampagnen und Chat nur im Bereich', async () => {
    expect((await req('GET', `${V}/campaigns`, undefined, h)).json.items.map((c: any) => c.title)).toEqual(['Regarion'])
    expect((await req('GET', `${V}/campaigns/curse-of-strahd/overview`, undefined, h)).status).toBe(404)
    const c = (await req('POST', `${V}/chat/context`, { question: 'Was passiert im Moor?' }, h)).json
    expect(c.text).not.toMatch(/Verrat|Vampir/)
  })

  it('darf nicht schreiben, kein anderes Notizbuch, keine gesperrten Funktionen', async () => {
    const w = await req('POST', `${V}/notes`, { type: 'npc', title: 'Neu' }, h)
    expect(w.status).toBe(403)
    expect(w.json.error.message).toMatch(/nur lesen/)
    expect((await req('GET', '/api/v1/vaults/notizen/notes', undefined, h)).status).toBe(403)
    for (const [m, u] of [
      ['GET', `${V}/trash`],
      ['GET', `${V}/notes/${ids['Kefir']}/history`],
      ['GET', `${V}/export.zip`],
      ['GET', `${V}/tree`],
      ['GET', `${V}/tags`],
      ['GET', `${V}/inbox`],
      ['GET', `${V}/proposals`],
      ['GET', '/api/v1/events'],
      ['GET', '/api/v1/tokens'],
    ]) {
      expect([m, u, (await req(m, u, undefined, h)).status]).toEqual([m, u, 403])
    }
    // Vault-Liste zeigt nur freigegebene Notizbücher
    expect((await req('GET', '/api/v1/vaults', undefined, h)).json.items.map((v: any) => v.id)).toEqual(['dnd'])
  })
})

describe('Freigabe: schreiben in Kampagne Regarion', () => {
  let h: Record<string, string>
  beforeAll(async () => {
    h = await token([{ vault: 'dnd', access: 'write', campaign: 'Regarion', shared: false }])
  })

  it('legt Notizen in der Kampagne an (Kampagne wird gesetzt)', async () => {
    const r = await req('POST', `${V}/notes`, { type: 'npc', title: 'Pepepe' }, h)
    expect(r.status).toBe(201)
    expect(r.json.campaign).toBe('Regarion')
  })

  it('verweigert Anlegen/Ändern außerhalb des Bereichs', async () => {
    expect((await req('POST', `${V}/notes`, { type: 'npc', title: 'Fremd', frontmatter: { campaign: 'Curse of Strahd' } }, h)).status).toBe(403)
    const kefir = (await req('GET', `${V}/notes/${ids['Kefir']}`, undefined, h)).json
    expect((await req('PATCH', `${V}/notes/${kefir.id}`, { frontmatter: { campaign: 'Curse of Strahd' } }, { ...h, 'if-match': kefir.version })).status).toBe(403)
    expect((await req('PATCH', `${V}/notes/${kefir.id}`, { frontmatter: { role: 'Magier' } }, { ...h, 'if-match': kefir.version })).status).toBe(200)
    expect((await req('DELETE', `${V}/notes/${ids['Strahd']}`, undefined, h)).status).toBe(404)
    expect((await req('PUT', `${V}/notes/${ids['Strahd']}/blocks/x`, { content: 'hack' }, h)).status).toBe(404)
    // shared: false → Lore ohne Kampagne ist nicht sichtbar
    expect((await req('GET', `${V}/notes/${ids['Götter der Welt']}`, undefined, h)).status).toBe(404)
  })
})

describe('Freigaben ohne Bereich und Ordner-Einschränkung', () => {
  it('je Notizbuch eigene Rechte; Kurator/Admin bleiben gesperrt', async () => {
    const h = await token([
      { vault: 'dnd', access: 'read' },
      { vault: 'notizen', access: 'write' },
    ])
    expect(titles((await req('GET', `${V}/notes?limit=100`, undefined, h)).json.items)).toContain('Strahd')
    expect((await req('POST', `${V}/notes`, { title: 'X' }, h)).status).toBe(403)
    expect((await req('POST', '/api/v1/vaults/notizen/notes', { title: 'Einkauf' }, h)).status).toBe(201)
    expect((await req('GET', `${V}/notes/${ids['Kefir']}/history`, undefined, h)).status).toBe(200)
    expect((await req('POST', '/api/v1/vaults/notizen/curator/duplicates?dry_run=1', undefined, h)).status).toBe(403)
    expect((await req('GET', '/api/v1/users', undefined, h)).status).toBe(403)
  })

  it('Ordner-Einschränkung: nur Notizen im Ordner, neue landen dort', async () => {
    await req('POST', '/api/v1/vaults/notizen/notes', { title: 'Privat', folder: 'Privat' })
    await req('POST', '/api/v1/vaults/notizen/notes', { title: 'Rezept Pizza', folder: 'Rezepte' })
    const h = await token([{ vault: 'notizen', access: 'write', folders: ['Rezepte'] }])
    expect(titles((await req('GET', '/api/v1/vaults/notizen/notes', undefined, h)).json.items)).toEqual(['Rezept Pizza'])
    const n = await req('POST', '/api/v1/vaults/notizen/notes', { title: 'Rezept Pasta' }, h)
    expect(n.status).toBe(201)
    expect(n.json.path).toMatch(/^Rezepte\//)
    expect((await req('POST', '/api/v1/vaults/notizen/notes', { title: 'Woanders', folder: 'Privat' }, h)).status).toBe(403)
  })

  it('Freigaben lassen sich ändern, ungültige werden abgelehnt', async () => {
    const created = await req('POST', '/api/v1/tokens', { name: 'x', grants: [{ vault: 'dnd', access: 'read' }] })
    const h = { authorization: `Bearer ${created.json.token}` }
    expect((await req('GET', '/api/v1/vaults/notizen/notes', undefined, h)).status).toBe(403)
    const upd = await req('PATCH', `/api/v1/tokens/${created.json.id}`, { grants: [{ vault: 'notizen', access: 'read' }] })
    expect(upd.json.grants).toEqual([{ vault: 'notizen', access: 'read' }])
    expect((await req('GET', '/api/v1/vaults/notizen/notes', undefined, h)).status).toBe(200)
    expect((await req('GET', `${V}/notes`, undefined, h)).status).toBe(403)
    expect((await req('POST', '/api/v1/tokens', { name: 'y', grants: [{ vault: 'gibtsnicht', access: 'read' }] })).status).toBe(404)
    expect((await req('POST', '/api/v1/tokens', { name: 'y', grants: [{ vault: 'dnd', access: 'admin' }] })).status).toBe(400)
    expect((await req('POST', '/api/v1/tokens', { name: 'y', grants: [{ vault: 'dnd', access: 'read', folders: ['../x'] }] })).status).toBe(400)
  })
})
