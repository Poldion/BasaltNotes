import fs from 'node:fs'
import path from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeLlm, makeApp } from './helpers.js'

let ctx: Awaited<ReturnType<typeof makeApp>>
const V = '/api/v1/vaults/dnd'

const EXTRACTION = {
  entities: [
    { name: 'Graf Strahd', type: 'npc', mentioned_as: [], summary: 'Herr von Barovia', facts: ['Wartet im Schloss Ravenloft auf die Gruppe'], properties: { attitude: 'feindlich' }, visibility: 'players', confidence: 0.95 },
    { name: 'Ravenloft', type: 'location', mentioned_as: [], summary: 'Schloss', facts: ['Thront über dem Dorf Barovia'], properties: {}, visibility: 'players', confidence: 0.9 },
  ],
  events: [],
  quests: [{ title: 'Ireena beschützen', status: 'offen', giver: 'Ismark', summary: 'Ismark bittet die Gruppe um Hilfe.' }],
  facts: [{ text: 'Strahd ist ein Vampir', visibility: 'players' }],
}

async function makePdf(pages: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const text of pages) {
    const p = doc.addPage()
    text.split('\n').forEach((line, i) => p.drawText(line, { x: 50, y: 750 - i * 18, size: 12, font }))
  }
  return Buffer.from(await doc.save())
}

function multipart(file: { name: string; data: Buffer; type?: string }, fields: Record<string, string> = {}) {
  const boundary = '----basalt' + Math.random().toString(16).slice(2)
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type ?? 'application/octet-stream'}\r\n\r\n`))
  parts.push(file.data)
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
}

async function upload(file: { name: string; data: Buffer }, fields: Record<string, string> = {}) {
  const m = multipart(file, fields)
  const res = await ctx.app.inject({ method: 'POST', url: `${V}/inbox/upload`, payload: m.payload, headers: { ...ctx.auth, ...m.headers } })
  return { status: res.statusCode, json: res.json() as any }
}

const get = async (url: string) => (await ctx.app.inject({ method: 'GET', url, headers: ctx.auth })).json() as any

beforeAll(async () => {
  ctx = await makeApp(new FakeLlm([{ match: /Ravenloft/, result: EXTRACTION }]))
})
afterAll(async () => ctx?.cleanup())

describe('Dokumente in den Eingang', () => {
  let first: any
  let pdfBytes: Buffer

  it('PDF hochladen: Anhang, Notiz mit Text, Kurator sortiert ein – alles als DM-Wissen', async () => {
    const pdf = await makePdf(['Kapitel 1: Ankunft in Barovia\nGraf Strahd wartet im Schloss Ravenloft.', 'Kapitel 2\nIsmark bittet um Schutz fuer Ireena.'])
    pdfBytes = pdf
    const r = await upload({ name: 'Fluch des Strahd – Skript.pdf', data: pdf }, { campaign: 'Fluch des Strahd' })
    expect(r.status).toBe(202)
    first = r.json
    const note = await get(`${V}/notes/${r.json.note_id}`)
    expect(note.type).toBe('script')
    expect(note.path).toBe('Fluch des Strahd/Skripte/Fluch des Strahd – Skript.md')
    expect(note.frontmatter.status).toBe('geplant')
    expect(note.visibility).toBe('dm')
    expect(note.frontmatter.pages).toBe(2)
    expect(note.frontmatter.document_kind).toBe('PDF')
    expect(note.body).toContain('## Seite 1')
    expect(note.body).toContain('Graf Strahd wartet im Schloss Ravenloft.')
    expect(note.body).toContain(`![[${note.frontmatter.document}]]`)
    const file = path.join(ctx.dataDir, 'vaults/dnd/_attachments', note.frontmatter.document)
    expect(fs.readFileSync(file).subarray(0, 4).toString()).toBe('%PDF')

    // Originaldatei abrufbar, im HTML verlinkt
    const att = await ctx.app.inject({ method: 'GET', url: `${V}/attachments/${encodeURIComponent(note.frontmatter.document)}`, headers: ctx.auth })
    expect(att.headers['content-type']).toBe('application/pdf')
    const html = (await ctx.app.inject({ method: 'GET', url: `${V}/notes/${note.id}/html`, headers: ctx.auth })).body
    expect(html).toContain('class="attachment-link"')

    await ctx.services.jobs.drain()
    expect((await get(`${V}/inbox/${r.json.inbox_id}`)).status).toBe('processed')
    // Kurator wusste, dass es ein Vorbereitungs-Skript ist
    const llm = (ctx.services.llm as FakeLlm).calls.find((c) => /Ravenloft/.test(c.user))!
    expect(llm.system).toContain('Vorbereitungs-Skript')
    // Kampagnen-Übersicht zeigt das geplante Skript (nur DM-Sicht)
    const ov = await get(`${V}/campaigns/fluch-des-strahd/overview`)
    expect(ov.scripts.map((x: any) => x.title)).toContain('Fluch des Strahd – Skript')
    expect((await get(`${V}/campaigns/fluch-des-strahd/overview?visibility=players`)).scripts).toHaveLength(0)
    const strahd = await get(`${V}/notes/by-title?title=Graf%20Strahd`)
    expect(strahd.visibility).toBe('dm')
    expect(strahd.blocks.every((b: any) => b.visibility === 'dm')).toBe(true)
    expect((await get(`${V}/notes/by-title?title=Ireena%20besch%C3%BCtzen`)).visibility).toBe('dm')
    // Spieler-Sicht sieht nichts davon
    const players = await get(`${V}/search?q=Ravenloft&visibility=players`)
    expect(players.items).toHaveLength(0)
  })

  it('Gleiche Datei erneut hochladen aktualisiert dieselbe Notiz', async () => {
    const pdf = pdfBytes
    const before = fs.readdirSync(path.join(ctx.dataDir, 'vaults/dnd/_attachments')).length
    const r = await upload({ name: 'Fluch des Strahd – Skript.pdf', data: pdf }, { campaign: 'Fluch des Strahd' })
    expect(r.json.note_id).toBe(first.note_id)
    expect(fs.readdirSync(path.join(ctx.dataDir, 'vaults/dnd/_attachments')).length).toBe(before)
  })

  it('Textdatei mit Titel, Typ und Spieler-Sichtbarkeit', async () => {
    const r = await upload({ name: 'notizen.txt', data: Buffer.from('Die Gruppe trifft Ismark im Dorf.\n') }, { title: 'Alte Notizen', type: 'note', visibility: 'players', curate: 'none' })
    expect(r.status).toBe(202)
    expect(r.json.status).toBe('stored')
    const note = await get(`${V}/notes/${r.json.note_id}`)
    expect(note.title).toBe('Alte Notizen')
    expect(note.type).toBe('note')
    expect(note.visibility).toBe('players')
  })

  it('PDF ohne Text (gescannt) und falsche Dateitypen werden abgelehnt', async () => {
    const empty = await makePdf(['', ''])
    const r1 = await upload({ name: 'scan.pdf', data: empty })
    expect(r1.status).toBe(400)
    expect(r1.json.error.message).toMatch(/OCR/)
    const r2 = await upload({ name: 'bild.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) })
    expect(r2.status).toBe(400)
    const r3 = await upload({ name: 'kaputt.pdf', data: Buffer.from('kein pdf') })
    expect(r3.status).toBe(400)
  })

  it('Spieler-Token darf nicht hochladen', async () => {
    const t = ctx.services.auth.createToken({ name: 'p', vaults: ['dnd'], scopes: ['read'], visibility: 'players' })
    const m = multipart({ name: 'x.txt', data: Buffer.from('x') })
    const res = await ctx.app.inject({ method: 'POST', url: `${V}/inbox/upload`, payload: m.payload, headers: { authorization: `Bearer ${t.token}`, ...m.headers } })
    expect(res.statusCode).toBe(403)
  })
})

describe('Anhänge sind keine Notizen', () => {
  it('Hochgeladene Markdown-Datei landet nur als Anhang, nicht als zweite Notiz', async () => {
    const before = (await get(`${V}/notes?limit=500`)).items.length
    const r = await upload({ name: 'skript.md', data: Buffer.from('# Skript\n\nIsmark wartet.\n') }, { curate: 'none' })
    expect(r.status).toBe(202)
    const after = await get(`${V}/notes?limit=500`)
    expect(after.items.length).toBe(before + 1)
    expect(after.items.some((n: any) => n.path.startsWith('_attachments/'))).toBe(false)
    expect((await get(`${V}/tree`)).folders.some((f: string) => f.startsWith('_'))).toBe(false)
  })
})

describe('Notizen-Vault ohne DM/Spieler-Sicht', () => {
  it('Upload legt keine Sichtbarkeit an, Typen-Schema ohne Sichtbarkeit', async () => {
    const m = multipart({ name: 'protokoll.txt', data: Buffer.from('Besprechung mit Anna zum Projekt Garten.\n') }, { curate: 'none' })
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/vaults/notizen/inbox/upload', payload: m.payload, headers: { ...ctx.auth, ...m.headers } })
    expect(res.statusCode).toBe(202)
    const note = await get(`/api/v1/vaults/notizen/notes/${res.json().note_id}`)
    expect(note.type).toBe('note')
    expect(note.frontmatter.visibility).toBeUndefined()
    const types = await get('/api/v1/vaults/notizen/types')
    expect(types.items[0].properties.some((p: any) => p.name === 'visibility')).toBe(false)
    const dndTypes = await get(`${V}/types`)
    expect(dndTypes.items.find((t: any) => t.name === 'script').properties.some((p: any) => p.name === 'visibility')).toBe(true)
  })
})

describe('Ältere Vaults', () => {
  it('bekommen den Typ „Skript“ beim Öffnen nachgerüstet', async () => {
    const v = ctx.services.vaults.get('dnd')
    const file = path.join(v.dir, '.basalt', 'vault.yaml')
    const yaml = fs.readFileSync(file, 'utf8')
    const scriptBlock = /^  script:\n(    .*\n)+/m
    // Stand vor 0.4: ohne script, ohne preset_revision
    fs.writeFileSync(file, yaml.replace(/^preset_revision:.*\n/m, '').replace(scriptBlock, ''))
    expect(v.loadConfig().types.script).toBeTruthy()
    const after = fs.readFileSync(file, 'utf8')
    expect(after).toMatch(/preset_revision: 4/)
    expect(after).toMatch(/^  monster:/m)
    expect(after).toMatch(/^  script:/m)
    // Wer den Typ danach entfernt, bekommt ihn nicht erneut
    fs.writeFileSync(file, after.replace(scriptBlock, ''))
    expect(v.loadConfig().types.script).toBeUndefined()
  })
})

describe('Anhang-Links', () => {
  it('Links auf hochgeladene Dateien gelten als aufgelöst', async () => {
    const pdf = await makePdf(['Ein kurzes Dokument ueber Ravenloft und das Dorf Barovia im Nebel.'])
    const r = await upload({ name: 'kurz.pdf', data: pdf }, { curate: 'none' })
    const note = await get(`${V}/notes/${r.json.note_id}`)
    const link = note.links.find((l: any) => l.target === note.frontmatter.document)
    expect(link.resolved).toBe(true)
    expect(link.attachment).toBe(true)
  })
})
