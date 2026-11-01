import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { FakeLlm } from './helpers.js'

const dirs: string[] = []
const start = async (dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'basalt-presets-'))) => {
  dirs.push(dataDir)
  process.env.ADMIN_PASSWORD = 'testpasswort123'
  const { app, services } = await buildApp({
    config: { dataDir, watch: false, commitDelayMs: 20, corsOrigins: [], embedOrigins: [], features: { curator: false, chat: false, setup_done: true } },
    llm: new FakeLlm([]),
    logger: false,
    webDir: null,
  })
  const headers = { authorization: `Bearer ${services.auth.createToken({ name: 'test', vaults: '*', scopes: ['admin'] }).token}` }
  const req = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: any) => {
    const r = await app.inject({ method, url: `/api/v1${url}`, payload, headers })
    return { status: r.statusCode, json: r.json() as any }
  }
  return { app, services, req, dataDir }
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('Vorlagen aus Plugins', () => {
  it('Neue Installation ist universell: kein D&D-Vault, keine D&D-Vorlage', async () => {
    const { app, services, req } = await start()
    expect(services.vaults.list().map((v) => v.id)).toEqual(['notizen'])
    expect((await req('GET', '/presets')).json.items.map((p: any) => p.id).sort()).toEqual(['empty', 'notes'])
    expect((await req('POST', '/vaults', { name: 'X', preset: 'dnd' })).status).toBe(400)
    expect((await req('POST', '/vaults/example')).status).toBe(404)
    await app.close()
  })

  it('Plugin einschalten macht Vorlage und Beispiel verfügbar', async () => {
    const { app, req } = await start()
    expect((await req('PUT', '/plugins/dnd', { enabled: true })).status).toBe(200)
    expect((await req('GET', '/presets')).json.items.map((p: any) => p.id)).toContain('dnd')
    expect((await req('POST', '/vaults', { name: 'Runde', preset: 'dnd' })).status).toBe(201)
    const ex = await req('POST', '/vaults/example')
    expect(ex.status).toBe(201)
    expect(ex.json.note_count).toBeGreaterThan(5)
    await app.close()
  })

  it('Bestehender D&D-Vault läuft ohne Zutun weiter, auch nach dem Neustart', async () => {
    const first = await start()
    await first.services.vaults.create('Alt', 'dnd')
    expect(first.services.plugins!.isEnabled('dnd')).toBe(true)
    await first.app.close()

    const second = await start(first.dataDir)
    expect(second.services.plugins!.isEnabled('dnd')).toBe(true)
    const v = second.services.vaults.get('alt')
    expect(v.config.curator.profile).toBe('dnd')
    expect(v.typeDef('npc').label).toBe('NPC')
    await second.app.close()
  })

  it('Ausschalten lässt die Typen bestehender Vaults stehen, sperrt aber neue', async () => {
    const { app, services, req } = await start()
    await services.vaults.create('Alt', 'dnd')
    await req('PUT', '/plugins/dnd', { enabled: false })
    expect(services.vaults.get('alt').typeDef('npc').label).toBe('NPC')
    expect((await req('POST', '/vaults', { name: 'Neu', preset: 'dnd' })).status).toBe(400)
    await app.close()
  })
})
