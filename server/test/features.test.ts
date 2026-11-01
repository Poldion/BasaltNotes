import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { FakeLlm, makeApp } from './helpers.js'

let ctx: Awaited<ReturnType<typeof makeApp>>
const D = '/api/v1/vaults/dnd'
const req = async (method: string, url: string, body?: any, headers: Record<string, string> = ctx.auth) => {
  const r = await ctx.app.inject({ method: method as any, url, payload: body, headers })
  return { status: r.statusCode, json: r.json() as any }
}

beforeAll(async () => {
  // Frische Einrichtung: keine Schalter vorgegeben
  ctx = await makeApp(new FakeLlm([]), { config: { features: undefined } })
})
afterAll(async () => ctx?.cleanup())

describe('KI-Funktionen schaltbar', () => {
  it('neue Einrichtung: Kurator und Chat aus, Einrichtung offen', async () => {
    expect((await req('GET', '/api/v1/system/features')).json).toEqual({ curator: false, chat: false, setup_done: false })
    expect((await req('GET', '/api/v1/auth/me')).json.features).toMatchObject({ curator: false, chat: false })
    expect(fs.readFileSync(path.join(ctx.dataDir, 'config.yaml'), 'utf8')).toMatch(/features:\n\s+curator: false/)
    expect((await req('GET', '/api/v1/health')).json.llm).toEqual({ enabled: false, reachable: false })
  })

  it('ausgeschaltet: Kurator- und Chat-Endpunkte gesperrt, Eingang legt nur ab', async () => {
    const chat = await req('POST', `${D}/chat/context`, { question: 'Wer ist Kefir?' })
    expect(chat.status).toBe(403)
    expect(chat.json.error.details.feature).toBe('chat')
    expect((await req('GET', `${D}/proposals`)).status).toBe(403)
    expect((await req('GET', `${D}/runs`)).status).toBe(403)
    expect((await req('GET', `${D}/curator/status`)).status).toBe(403)
    const inbox = await req('POST', `${D}/inbox`, { note: { title: 'Session 9', body: 'Die Gruppe traf Kefir.' } })
    expect(inbox.status).toBe(202)
    expect(inbox.json.status).toBe('stored')
    expect((await req('GET', `${D}/notes/${inbox.json.note_id}`)).json.title).toBe('Session 9')
    expect(ctx.services.jobs.pending(['curate_inbox'], 'dnd')).toHaveLength(0)
    // Notizen, Suche usw. funktionieren normal
    expect((await req('GET', `${D}/search?q=Kefir`)).json.items.length).toBe(1)
  })

  it('einschalten (nur Admin) gilt sofort', async () => {
    const tok = ctx.services.auth.createToken({ name: 'x', vaults: '*', scopes: ['read', 'write'] })
    expect((await req('PUT', '/api/v1/system/features', { chat: true }, { authorization: `Bearer ${tok.token}` })).status).toBe(403)
    const r = await req('PUT', '/api/v1/system/features', { chat: true, curator: true, setup_done: true })
    expect(r.json).toEqual({ curator: true, chat: true, setup_done: true })
    expect((await req('POST', `${D}/chat/context`, { question: 'Wer ist Kefir?' })).status).toBe(200)
    expect((await req('GET', `${D}/proposals`)).status).toBe(200)
    expect(fs.readFileSync(path.join(ctx.dataDir, 'config.yaml'), 'utf8')).toMatch(/chat: true/)
  })
})

describe('Update einer bestehenden Installation', () => {
  it('Kurator schon benutzt → bleibt an; nur Notizen → aus, aber keine Einrichtung mehr', async () => {
    // Installation mit Eingang (Kurator benutzt): Schalter fehlen in config.yaml
    const file = path.join(ctx.dataDir, 'config.yaml')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/features:\n(\s+.*\n)+/, ''))
    await ctx.app.close()
    const again = await buildApp({ config: { dataDir: ctx.dataDir, watch: false, commitDelayMs: 20 }, llm: new FakeLlm([]), logger: false, webDir: null })
    expect(again.services.config.features).toEqual({ curator: true, chat: true, setup_done: true })
    await again.app.close()
    // Nur Notizen, nie Kurator benutzt
    const dir2 = path.join(ctx.dataDir, '..', path.basename(ctx.dataDir) + '-2')
    fs.mkdirSync(dir2, { recursive: true })
    const a = await buildApp({ config: { dataDir: dir2, watch: false, commitDelayMs: 20, features: { curator: false, chat: false, setup_done: false } }, llm: new FakeLlm([]), logger: false, webDir: null })
    const tok = a.services.auth.createToken({ name: 'x', vaults: '*', scopes: ['admin'] })
    await a.app.inject({ method: 'POST', url: '/api/v1/vaults/notizen/notes', payload: { title: 'Eine Notiz' }, headers: { authorization: `Bearer ${tok.token}` } })
    await a.app.close()
    const b = await buildApp({ config: { dataDir: dir2, watch: false, commitDelayMs: 20 }, llm: new FakeLlm([]), logger: false, webDir: null })
    expect(b.services.config.features).toEqual({ curator: false, chat: false, setup_done: true })
    await b.app.close()
    fs.rmSync(dir2, { recursive: true, force: true })
    // ctx.cleanup soll nicht erneut schließen
    ctx.app.close = async () => undefined as any
  })
})
