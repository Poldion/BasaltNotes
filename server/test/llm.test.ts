import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OllamaClient } from '../src/curator/llm.js'
import { isCancelled } from '../src/lib/errors.js'

/** Fake-Ollama: Verhalten je Prompt steuerbar */
let server: http.Server
let url = ''
let chatCalls = 0
let lastBody: any = null

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    if (req.url === '/api/ps') return res.writeHead(404).end('not found')
    if (req.url === '/api/tags') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ models: [{ name: 'LocalLLM', details: { context_length: 262144 } }] }))
    if (req.url === '/admin/state') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ forced_options: { num_ctx: 32768 } }))
    if (req.url !== '/api/chat') return res.writeHead(404).end()
    chatCalls++
    let raw = ''
    for await (const c of req) raw += c
    lastBody = JSON.parse(raw)
    const mode = lastBody.messages[1].content as string
    if (mode === 'kann-nicht-denken' && lastBody.think !== false && lastBody.think !== undefined) {
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: '"x" does not support thinking' }))
    }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    const send = (o: any) => res.write(JSON.stringify(o) + '\n')
    const pieces = ['{"a"', ':', ' 1', ', "b": "x', 'y"}']
    if (mode === 'langsam') {
      for (const p of pieces) {
        await sleep(80)
        send({ message: { content: p }, done: false })
      }
      send({ message: { content: '' }, done: true, done_reason: 'stop' })
      return res.end()
    }
    if (mode === 'stockt') {
      send({ message: { content: '{"a"' }, done: false })
      await sleep(2000)
      return res.end()
    }
    if (mode === 'schweigt') {
      await sleep(2000)
      return res.end()
    }
    if (mode === 'denkt') {
      // Nachdenken über mehrere Pausen hinweg, die zusammen länger als idle_ms sind
      for (let i = 0; i < 6; i++) {
        await sleep(80)
        send({ message: { content: '', thinking: 'hm ' }, done: false })
      }
      send({ message: { content: '{"ok": 1}' }, done: false })
      send({ message: { content: '' }, done: true, done_reason: 'stop' })
      return res.end()
    }
    if (mode === 'denkt-im-text') {
      for (const p of ['<thi', 'nk>Erst überlegen', ' …</think>', '\n\nDie ', 'Antwort.']) send({ message: { content: p }, done: false })
      send({ message: { content: '' }, done: true, done_reason: 'stop' })
      return res.end()
    }
    if (mode === 'abgeschnitten') {
      send({ message: { content: '{"a": [1, 2' }, done: false })
      send({ message: { content: '' }, done: true, done_reason: 'length' })
      return res.end()
    }
    if (mode === 'lang') {
      for (let i = 0; i < 100; i++) {
        await sleep(20)
        if (res.destroyed) return
        send({ message: { content: ' ' }, done: false })
      }
      send({ message: { content: '{}' }, done: true })
      return res.end()
    }
    send({ message: { content: '{"ok": true}' }, done: true })
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

const client = (o: Partial<{ timeout_ms: number; idle_ms: number }> = {}) => new OllamaClient({ url, timeout_ms: 500, idle_ms: 300, retries: 2, ...o })

describe('LLM-Client (Streaming)', () => {
  it('erkennt Modell und Kontextgröße: /api/ps 404 → /api/tags, Kontext aus dem Proxy', async () => {
    const info = await client().info(true)
    expect(info).toMatchObject({ reachable: true, model: 'LocalLLM', context: 32768, context_source: 'proxy_state' })
  })

  it('nimmt beim gewählten Modell dessen eigenes Kontextfenster statt das des geladenen Standardmodells', async () => {
    const srv = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/api/ps') {
        // Nur das favorisierte Standardmodell (Qwen3.6) ist gerade geladen
        return res.end(JSON.stringify({ models: [{ name: 'Qwen3.6', model: 'Qwen3.6', context_length: 256000 }] }))
      }
      if (req.url === '/admin/state') {
        return res.end(
          JSON.stringify({
            models: [
              { model: 'Agen/gemma-4-26B:latest', alias: 'Gemma4', forced_options: { num_ctx: 64000 } },
              { model: 'huihui_ai/Qwen3.6:35b', alias: 'Qwen3.6', forced_options: { num_ctx: 256000 } },
            ],
            default_model: 'huihui_ai/Qwen3.6:35b',
          }),
        )
      }
      res.writeHead(404).end('{}')
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
    const u = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
    try {
      const gemma = await new OllamaClient({ url: u, model: 'Gemma4', timeout_ms: 500, idle_ms: 300, retries: 1 }).info(true)
      expect(gemma).toMatchObject({ reachable: true, model: 'Gemma4', context: 64000, context_source: 'proxy_state' })

      const auto = await new OllamaClient({ url: u, timeout_ms: 500, idle_ms: 300, retries: 1 }).info(true)
      expect(auto).toMatchObject({ reachable: true, model: 'Qwen3.6', context: 256000, context_source: 'api_ps' })
    } finally {
      await new Promise<void>((r) => srv.close(() => r()))
    }
  })

  it('setzt eine langsame Antwort aus Teilen zusammen und meldet Fortschritt', async () => {
    const seen: number[] = []
    // Gesamtdauer (~400 ms) liegt über idle_ms – erlaubt, solange Tokens kommen
    const r = await client({ idle_ms: 300 }).chatJson({ system: 's', user: 'langsam', onToken: (n) => seen.push(n) })
    expect(r).toEqual({ a: 1, b: 'xy' })
    expect(seen.at(-1)).toBe(5)
    expect(lastBody.stream).toBe(true)
    expect(lastBody.options.num_ctx).toBe(32768)
  })

  it('bricht ab, wenn das LLM mitten in der Antwort stehen bleibt – ohne Wiederholung', async () => {
    const before = chatCalls
    const err: any = await client().chatJson({ system: 's', user: 'stockt' }).catch((e) => e)
    expect(err.code).toBe('llm_unavailable')
    expect(err.details.reason).toBe('timeout')
    expect(err.noRetry).toBe(true)
    expect(err.message).toMatch(/nichts mehr geliefert/)
    expect(chatCalls - before).toBe(1)
  })

  it('bricht ab, wenn das erste Token zu lange ausbleibt', async () => {
    const err: any = await client().chatJson({ system: 's', user: 'schweigt' }).catch((e) => e)
    expect(err.details.reason).toBe('timeout')
    expect(err.message).toMatch(/nicht zu antworten begonnen/)
  })

  it('meldet abgeschnittene Antworten verständlich', async () => {
    const err: any = await client().chatJson({ system: 's', user: 'abgeschnitten' }).catch((e) => e)
    expect(err.details.reason).toBe('truncated')
    expect(err.message).toMatch(/abgeschnitten/)
  })

  it('Stoppen trennt die laufende Antwort sofort', async () => {
    const ctrl = new AbortController()
    const t0 = Date.now()
    const p = client({ idle_ms: 5000 }).chatJson({ system: 's', user: 'lang', signal: ctrl.signal }).catch((e) => e)
    await sleep(150)
    ctrl.abort()
    const err = await p
    expect(isCancelled(err)).toBe(true)
    expect(Date.now() - t0).toBeLessThan(1000)
  })
})

describe('LLM-Client: Nachdenken (Thinking)', () => {
  const thinking = (mode: 'off' | 'on' | 'low' | 'medium' | 'high', o: Partial<{ idle_ms: number }> = {}) =>
    new OllamaClient({ url, timeout_ms: 500, idle_ms: 300, retries: 2, think_chat: mode, think_curator: mode, ...o })

  it('schickt standardmäßig think: false und bei Stufen den Wert, mit mehr Antwort-Tokens', async () => {
    await client().chatJson({ system: 's', user: 'x', reserveTokens: 1000 })
    expect(lastBody.think).toBe(false)
    expect(lastBody.options.num_predict).toBe(1000)
    await thinking('high').chatJson({ system: 's', user: 'x', reserveTokens: 1000 })
    expect(lastBody.think).toBe('high')
    expect(lastBody.options.num_predict).toBe(1000 + 4096)
    await thinking('on').chatText({ system: 's', messages: [{ role: 'user', content: 'x' }] })
    expect(lastBody.think).toBe(true)
  })

  it('Nachdenken hält die Verbindung am Leben, gehört aber nicht zur Antwort', async () => {
    const thoughts: string[] = []
    const tokens: number[] = []
    const r = await thinking('on').chatJson({ system: 's', user: 'denkt', onToken: (n) => tokens.push(n) })
    expect(r).toEqual({ ok: 1 })
    expect(tokens.length).toBeGreaterThanOrEqual(6)
    const t = await thinking('on').chatText({ system: 's', messages: [{ role: 'user', content: 'denkt' }], onThinking: (x) => thoughts.push(x) })
    expect(t).toBe('{"ok": 1}')
    expect(thoughts.join('')).toBe('hm hm hm hm hm hm ')
  })

  it('trennt <think>…</think> im Text von der Antwort', async () => {
    const thoughts: string[] = []
    const text: string[] = []
    const r = await thinking('on').chatText({ system: 's', messages: [{ role: 'user', content: 'denkt-im-text' }], onThinking: (x) => thoughts.push(x), onText: (x) => text.push(x) })
    expect(r).toBe('Die Antwort.')
    expect(text.join('')).toBe('Die Antwort.')
    expect(thoughts.join('')).toBe('Erst überlegen …')
  })

  it('Modell ohne Nachdenken: fällt still auf think: false zurück', async () => {
    const r = await thinking('high').chatJson({ system: 's', user: 'kann-nicht-denken' })
    expect(r).toEqual({ ok: true })
    expect(lastBody.think).toBe(false)
  })
})
