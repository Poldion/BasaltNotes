import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeLlm, makeApp } from './helpers.js'

let ctx: Awaited<ReturnType<typeof makeApp>>
let server: http.Server
let url = ''
const req = async (method: string, u: string, body?: any, headers = ctx.auth) => {
  const r = await ctx.app.inject({ method: method as any, url: `/api/v1${u}`, payload: body, headers })
  return { status: r.statusCode, json: r.json() as any }
}

beforeAll(async () => {
  ctx = await makeApp(new FakeLlm([]))
  server = http.createServer((rq, res) => {
    res.setHeader('content-type', 'application/json')
    if (rq.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'gemma3:4b', size: 3e9, details: { parameter_size: '4.3B', quantization_level: 'Q4_K_M' } }, { name: 'qwen3:8b' }] }))
    if (rq.url === '/api/ps') return res.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }))
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  server?.close()
  await ctx?.cleanup()
})

describe('LLM-Einstellungen', () => {
  it('listet die Modelle eines Servers, auch vor dem Speichern', async () => {
    const r = await req('GET', `/system/llm/models?url=${encodeURIComponent(url)}`)
    expect(r.status).toBe(200)
    expect(r.json.models.map((m: any) => m.name)).toEqual(['gemma3:4b', 'qwen3:8b'])
    expect(r.json.models.find((m: any) => m.name === 'qwen3:8b').loaded).toBe(true)
    expect(r.json.models[0].parameter_size).toBe('4.3B')
  })

  it('nicht erreichbarer Server → verständlicher Fehler', async () => {
    const r = await req('GET', `/system/llm/models?url=${encodeURIComponent('http://127.0.0.1:1')}`)
    expect(r.status).toBe(503)
    expect(r.json.error.message).toMatch(/nicht erreichbar/)
  })

  it('speichert Adresse und Modell, gilt sofort und übersteht einen Neustart', async () => {
    const r = await req('PUT', '/system/llm', { url: url + '/', model: 'gemma3:4b', num_ctx: 8192 })
    expect(r.status).toBe(200)
    expect(r.json.url).toBe(url)
    expect(r.json.model).toBe('gemma3:4b')
    expect(ctx.services.config.llm.url).toBe(url)
    expect(ctx.services.config.llm.num_ctx).toBe(8192)
    const yaml = fs.readFileSync(path.join(ctx.dataDir, 'config.yaml'), 'utf8')
    expect(yaml).toMatch(/llm_override:/)
    // Vorrang vor Umgebungsvariablen
    process.env.LLM_URL = 'http://anders:11434'
    const { loadConfig } = await import('../src/config.js')
    expect(loadConfig({ dataDir: ctx.dataDir }).llm.url).toBe(url)
    delete process.env.LLM_URL
  })

  it('leeres Modell = automatisch; Zurücksetzen entfernt die Einstellung', async () => {
    expect((await req('PUT', '/system/llm', { model: '' })).json.model).toBeNull()
    const r = await req('PUT', '/system/llm', { reset: true })
    expect(r.json.override).toBeNull()
    expect(ctx.services.config.llm.url).not.toBe(url)
  })

  it('Nachdenken getrennt für Chat und Kurator einstellbar', async () => {
    const r = await req('PUT', '/system/llm', { think_chat: 'high', think_curator: 'off' })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ think_chat: 'high', think_curator: 'off' })
    expect(ctx.services.config.llm.think_chat).toBe('high')
    expect((await req('PUT', '/system/llm', { think_chat: 'sehr' })).status).toBe(400)
    await req('PUT', '/system/llm', { reset: true })
    expect(ctx.services.config.llm.think_chat).toBe('off')
  })

  it('prüft die Adresse und verlangt Admin-Rechte', async () => {
    expect((await req('PUT', '/system/llm', { url: 'ollama.local:11434' })).status).toBe(400)
    const tok = ctx.services.auth.createToken({ name: 'leser', vaults: '*', scopes: ['read'] })
    expect((await req('GET', '/system/llm', undefined, { authorization: `Bearer ${tok.token}` })).status).toBe(403)
  })
})
