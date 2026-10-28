import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeLlm, makeApp } from './helpers.js'

let ctx: Awaited<ReturnType<typeof makeApp>>
let dataDir = ''
const req = async (method: string, url: string, body?: any, headers: Record<string, string> = ctx.auth) => {
  const r = await ctx.app.inject({ method: method as any, url, payload: body, headers })
  let json: any = null
  try {
    json = r.json()
  } catch {
    json = null
  }
  return { status: r.statusCode, json, raw: r.payload, headers: r.headers }
}

beforeAll(async () => {
  // Eigenes Plugin unter <data>/plugins – vor dem Start ablegen
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'basalt-plugins-'))
  const dir = path.join(dataDir, 'plugins', 'hallo')
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ id: 'hallo', name: 'Hallo', version: '0.1.0', server: 'dist/server.js', web: 'dist/web.js', default_enabled: true }),
  )
  fs.writeFileSync(
    path.join(dir, 'dist', 'server.js'),
    `export default {
  api(app, ctx) {
    app.get('/vaults/:vault/hallo', async (req) => {
      const v = ctx.helpers.vaultFor(req, 'read')
      const n = ctx.db.get('SELECT COUNT(*) AS n FROM notes WHERE vault = ?', v.id).n
      return { hallo: v.config.name, notizen: n, einstellungen: ctx.settings.get() }
    })
    app.post('/vaults/:vault/hallo', async (req) => {
      ctx.helpers.vaultFor(req, 'write')
      ctx.settings.set({ gruss: req.body.gruss })
      return { ok: true }
    })
  },
}
`,
  )
  fs.writeFileSync(path.join(dir, 'dist', 'web.js'), 'export default function activate(ctx) {}\n')
  fs.writeFileSync(path.join(dir, 'geheim.txt'), 'nicht ausliefern')
  ctx = await makeApp(new FakeLlm([]), { config: { dataDir } })
})
afterAll(async () => ctx?.cleanup())

describe('Plugins', () => {
  it('listet mitgelieferte und eigene Plugins', async () => {
    const items = (await req('GET', '/api/v1/plugins')).json.items
    const cal = items.find((p: any) => p.id === 'calendar')
    expect(cal).toMatchObject({ builtin: true, enabled: true, error: null, name: 'Kalender & CalDAV' })
    expect(cal.web).toMatch(/^\/plugins\/calendar\/dist\/web\.js\?v=/)
    expect(items.find((p: any) => p.id === 'hallo')).toMatchObject({ builtin: false, enabled: true, version: '0.1.0' })
  })

  it('eigenes Plugin: Endpunkte mit Anmeldung, Rechten, Datenbank und Einstellungen', async () => {
    await req('POST', '/api/v1/vaults/dnd/notes', { title: 'Eine Notiz' })
    expect((await req('GET', '/api/v1/vaults/dnd/hallo')).json).toEqual({ hallo: 'DnD', notizen: 1, einstellungen: {} })
    expect((await req('GET', '/api/v1/vaults/dnd/hallo', undefined, {})).status).toBe(401)
    const ro = ctx.services.auth.createToken({ name: 'ro', vaults: ['dnd'], scopes: ['read'] })
    expect((await req('POST', '/api/v1/vaults/dnd/hallo', { gruss: 'x' }, { authorization: `Bearer ${ro.token}` })).status).toBe(403)
    await req('POST', '/api/v1/vaults/dnd/hallo', { gruss: 'Moin' })
    expect((await req('GET', '/api/v1/vaults/dnd/hallo')).json.einstellungen).toEqual({ gruss: 'Moin' })
  })

  it('ausschalten wirkt sofort – auch für CalDAV – und lässt sich rückgängig machen', async () => {
    expect((await req('GET', '/api/v1/vaults/dnd/calendar')).status).toBe(200)
    const tok = ctx.services.auth.createToken({ name: 'ha', vaults: '*', scopes: ['read'] })
    const basic = { authorization: `Basic ${Buffer.from(`ha:${tok.token}`).toString('base64')}`, depth: '0' }
    expect((await req('PROPFIND', '/dav/', undefined, basic)).status).toBe(207)

    const nonAdmin = ctx.services.auth.createToken({ name: 'x', vaults: '*', scopes: ['read', 'write'] })
    expect((await req('PUT', '/api/v1/plugins/calendar', { enabled: false }, { authorization: `Bearer ${nonAdmin.token}` })).status).toBe(403)
    const off = await req('PUT', '/api/v1/plugins/calendar', { enabled: false })
    expect(off.json.items.find((p: any) => p.id === 'calendar').enabled).toBe(false)
    expect((await req('GET', '/api/v1/vaults/dnd/calendar')).status).toBe(404)
    expect((await req('PROPFIND', '/dav/', undefined, basic)).status).toBe(404)
    expect(fs.readFileSync(path.join(dataDir, 'config.yaml'), 'utf8')).toMatch(/\n\s+calendar:\n\s+enabled: false/)

    await req('PUT', '/api/v1/plugins/calendar', { enabled: true })
    expect((await req('GET', '/api/v1/vaults/dnd/calendar')).status).toBe(200)
    expect((await req('PUT', '/api/v1/plugins/gibtsnicht', { enabled: true })).status).toBe(404)
  })

  it('liefert nur die Oberflächen-Dateien aus', async () => {
    const js = await req('GET', '/plugins/hallo/dist/web.js', undefined, {})
    expect(js.status).toBe(200)
    expect(js.headers['content-type']).toMatch(/javascript/)
    expect((await req('GET', '/plugins/hallo/geheim.txt', undefined, {})).status).toBe(404)
    expect((await req('GET', '/plugins/hallo/dist/../manifest.json', undefined, {})).status).toBe(404)
    expect((await req('GET', '/plugins/hallo/dist/server.js', undefined, {})).status).toBe(200) // liegt im selben Ordner – Code ist nicht geheim
    expect((await req('GET', '/plugins/gibtsnicht/x.js', undefined, {})).status).toBe(404)
  })
})
