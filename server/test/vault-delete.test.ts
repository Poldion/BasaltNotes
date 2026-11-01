import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FakeLlm, makeApp } from './helpers.js'

let ctx: Awaited<ReturnType<typeof makeApp>>
const A = '/api/v1'
const req = async (method: string, url: string, body?: any) => {
  const r = await ctx.app.inject({ method: method as any, url, payload: body, headers: ctx.auth })
  return { status: r.statusCode, json: r.json() as any }
}
const trash = () => path.join(ctx.services.vaults.root, '..', 'deleted-vaults')
const trashed = (id: string) => (fs.existsSync(trash()) ? fs.readdirSync(trash()).filter((d) => d.startsWith(`${id}-`)) : [])

/** Verhält sich wie ein Mount auf /data/vaults: Verschieben in den Papierkorb geht nicht direkt */
function acrossMounts() {
  const rename = fs.renameSync
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to).includes('deleted-vaults')) throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
    rename(from, to)
  })
}

beforeAll(async () => {
  ctx = await makeApp(new FakeLlm([]))
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => ctx?.cleanup())

describe('Vault löschen', () => {
  it('Auf demselben Dateisystem wird der Ordner verschoben', async () => {
    await req('POST', `${A}/vaults`, { name: 'Direkt' })
    expect((await req('DELETE', `${A}/vaults/direkt`)).status).toBe(200)
    expect(trashed('direkt')).toHaveLength(1)
    expect(fs.existsSync(path.join(ctx.services.vaults.root, 'direkt'))).toBe(false)
  })

  it('Vaults auf eigenem Mount: Inhalt samt Verlauf landet im Papierkorb, der Name ist wieder frei', async () => {
    await req('POST', `${A}/vaults`, { name: 'Mount' })
    const n = await req('POST', `${A}/vaults/mount/notes`, { title: 'Bleibt erhalten', body: 'Inhalt' })
    expect(n.status).toBe(201)
    acrossMounts()

    expect((await req('DELETE', `${A}/vaults/mount`)).status).toBe(200)
    expect((await req('GET', `${A}/vaults/mount`)).status).toBe(404)
    const [dir] = trashed('mount')
    const copy = path.join(trash(), dir)
    expect(fs.readdirSync(copy, { recursive: true }).map(String).some((f) => f.endsWith('Bleibt erhalten.md'))).toBe(true)
    expect(fs.existsSync(path.join(copy, '.git'))).toBe(true)
    expect(fs.readdirSync(ctx.services.vaults.root).filter((d) => d.includes('mount'))).toEqual([])
    expect((await req('POST', `${A}/vaults`, { name: 'Mount' })).status).toBe(201)
  })

  it('Scheitert das Kopieren, bleibt der Vault vollständig erhalten', async () => {
    await req('POST', `${A}/vaults`, { name: 'Voll' })
    const n = await req('POST', `${A}/vaults/voll/notes`, { title: 'Sicher' })
    acrossMounts()
    vi.spyOn(fs.promises, 'cp').mockRejectedValue(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }))

    expect((await req('DELETE', `${A}/vaults/voll`)).status).toBe(500)
    vi.restoreAllMocks()
    expect(trashed('voll')).toEqual([])
    expect(fs.readdirSync(ctx.services.vaults.root).filter((d) => d.includes('voll'))).toEqual(['voll'])
    expect((await req('GET', `${A}/vaults/voll/notes/${n.json.id}`)).status).toBe(200)
    expect((await req('POST', `${A}/vaults/voll/notes`, { title: 'Geht weiter' })).status).toBe(201)
  })
})
