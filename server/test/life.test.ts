import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listTasks, setTask } from '../src/notes/markdown.js'
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
  expect((await req('POST', '/api/v1/vaults', { name: 'Leben', id: 'leben', preset: 'notes' })).status).toBe(201)
})
afterAll(async () => ctx?.cleanup())

describe('Notiz-App fürs Leben', () => {
  it('hat Typen für Tagebuch, Aufgaben, Listen, Termine und Sammlungen', async () => {
    const types = (await req('GET', `${N}/types`)).json.items.map((t: any) => t.name)
    for (const t of ['journal', 'task', 'list', 'event', 'recipe', 'idea', 'bookmark', 'howto', 'note', 'meeting']) expect(types).toContain(t)
    const recipe = (await req('POST', `${N}/notes`, { type: 'recipe', title: 'Pizza' })).json
    expect(recipe.path).toBe('Rezepte/Pizza.md')
    expect(recipe.body).toContain('## Zutaten')
  })

  it('ältere Notizen-Vaults bekommen die neuen Typen nachgerüstet', async () => {
    const file = path.join(ctx.dataDir, 'vaults', 'leben', '.basalt', 'vault.yaml')
    const yaml = fs.readFileSync(file, 'utf8')
    const old = yaml.replace(/^preset_revision:.*$/m, 'preset_revision: 3').replace(/^ {2}(journal|task|list|event|recipe|idea|bookmark|howto):\n( {4}.*\n)+/gm, '')
    expect(old).not.toMatch(/journal:/)
    fs.writeFileSync(file, old)
    ctx.services.vaults.get('leben').loadConfig()
    expect(Object.keys(ctx.services.vaults.get('leben').config.types)).toContain('journal')
    expect(fs.readFileSync(file, 'utf8')).toMatch(/preset_revision: 4/)
  })

  it('„Heute“ legt den Tagebuch-Eintrag einmal an und findet ihn danach wieder', async () => {
    const a = await req('POST', `${N}/journal/today`, { date: '2026-10-28' })
    expect(a.status).toBe(201)
    expect(a.json).toMatchObject({ title: '2026-10-28', type: 'journal', created: true })
    expect(a.json.path).toBe('Tagebuch/2026/2026-10-28.md')
    expect(a.json.body).toContain('## Dankbar für')
    const b = await req('POST', `${N}/journal/today`, { date: '2026-10-28' })
    expect(b.status).toBe(200)
    expect(b.json).toMatchObject({ id: a.json.id, created: false })
    expect((await req('POST', '/api/v1/vaults', { name: 'Ohne', id: 'ohne', preset: 'empty' })).status).toBe(201)
    expect((await req('POST', '/api/v1/vaults/ohne/journal/today', {})).status).toBe(400)
  })
})

describe('Checklisten', () => {
  const body = ['# Einkauf', '', '- [ ] Milch', '- [x] **Brot**', '  - [ ] Vollkorn', '', '```', '- [ ] kein echter Punkt', '```', '1. [ ] [[Pizza]] backen', '- [ ] ', ''].join('\n')

  it('findet Aufgaben wie die Darstellung (ohne Code-Blöcke und leere Punkte)', () => {
    expect(listTasks(body).map((t) => [t.checked, t.text])).toEqual([
      [false, 'Milch'],
      [true, '**Brot**'],
      [false, 'Vollkorn'],
      [false, '[[Pizza]] backen'],
    ])
    expect(setTask(body, 2, true)).toBe(body.replace('  - [ ] Vollkorn', '  - [x] Vollkorn'))
  })

  it('abhaken über die API ändert genau ein Zeichen; Darstellung hat anklickbare Checkboxen', async () => {
    const n = (await req('POST', `${N}/notes`, { type: 'list', title: 'Einkauf', body, frontmatter: { category: 'Einkauf' } })).json
    const html = (await req('GET', `${N}/notes/${n.id}/html?tasks=1`)).raw
    expect(html.match(/data-task="\d"/g)).toEqual(['data-task="0"', 'data-task="1"', 'data-task="2"', 'data-task="3"'])
    expect((await req('GET', `${N}/notes/${n.id}/html`)).raw).not.toContain('data-task')
    const r = await req('POST', `${N}/notes/${n.id}/tasks/1`, { checked: false, text: 'Brot' })
    expect(r.status).toBe(200)
    // Nur das Häkchen ändert sich (plus wie immer der Änderungszeitpunkt im Frontmatter)
    expect(r.json.body).toBe(n.body.replace('- [x] **Brot**', '- [ ] **Brot**'))
    expect(r.json.raw.replace(/^updated:.*$/m, '')).toBe(n.raw.replace('- [x] **Brot**', '- [ ] **Brot**').replace(/^updated:.*$/m, ''))
    // Link-Text wie angezeigt
    expect((await req('POST', `${N}/notes/${n.id}/tasks/3`, { checked: true, text: 'Pizza backen' })).status).toBe(200)
    // Liste hat sich geändert → Konflikt statt falschen Punkt abzuhaken
    expect((await req('POST', `${N}/notes/${n.id}/tasks/0`, { checked: true, text: 'Eier' })).status).toBe(409)
    expect((await req('POST', `${N}/notes/${n.id}/tasks/9`, { checked: true })).status).toBe(404)
    const items = (await req('GET', `${N}/notes/${n.id}/tasks`)).json.items
    expect(items.map((t: any) => t.checked)).toEqual([false, false, false, true])
  })

  it('nur-lesen: keine anklickbaren Checkboxen, kein Abhaken', async () => {
    const n = (await req('GET', `${N}/notes/by-title?title=Einkauf`)).json
    const tok = (await req('POST', '/api/v1/tokens', { name: 'ha', grants: [{ vault: 'leben', access: 'read' }] })).json.token
    const h = { authorization: `Bearer ${tok}` }
    expect((await req('GET', `${N}/notes/${n.id}/html?tasks=1`, undefined, h)).raw).not.toContain('data-task')
    expect((await req('POST', `${N}/notes/${n.id}/tasks/0`, { checked: true }, h)).status).toBe(403)
  })
})

describe('Eigene Typen', () => {
  it('legt einen Typ mit Feldern, Ordner und Vorlage an und benutzt ihn', async () => {
    const r = await req('PUT', `${N}/types/wein`, {
      label: 'Wein',
      folder: 'Sammlungen/Wein',
      properties: [
        { name: 'winery', label: 'Weingut', type: 'text' },
        { name: 'rating', label: 'Bewertung', type: 'select', options: ['★', '★★', '★★★'] },
      ],
      template_body: '# {{title}}\n\n## Geschmack\n',
    })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ name: 'wein', label: 'Wein', folder: 'Sammlungen/Wein', builtin: false })
    const n = (await req('POST', `${N}/notes`, { type: 'wein', title: 'Riesling 2022', frontmatter: { rating: '★★★' } })).json
    expect(n.path).toBe('Sammlungen/Wein/Riesling 2022.md')
    expect(n.body).toContain('## Geschmack')
    const t = (await req('GET', `${N}/types/wein`)).json
    expect(t.template_body).toContain('## Geschmack')
    expect(t.note_count).toBe(1)
    expect((await req('GET', `${N}/types`)).json.items.find((x: any) => x.name === 'recipe').builtin).toBe(true)
  })

  it('prüft Eingaben und entfernt Typen nur ohne Notizen', async () => {
    expect((await req('PUT', `${N}/types/Wein!`, { label: 'x' })).status).toBe(400)
    expect((await req('PUT', `${N}/types/x`, { label: 'X', properties: [{ name: 'title', type: 'text' }] })).status).toBe(400)
    expect((await req('PUT', `${N}/types/x`, { label: 'X', properties: [{ name: 'a', type: 'select' }] })).status).toBe(400)
    expect((await req('PUT', `${N}/types/x`, { label: 'X', folder: '../raus' })).status).toBe(400)
    expect((await req('DELETE', `${N}/types/wein`)).status).toBe(409)
    expect((await req('PUT', `${N}/types/leer`, { label: 'Leer' })).status).toBe(200)
    expect((await req('DELETE', `${N}/types/leer`)).status).toBe(200)
    expect((await req('GET', `${N}/types`)).json.items.map((x: any) => x.name)).not.toContain('leer')
  })
})
