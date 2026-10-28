import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeLlm, makeApp } from './helpers.js'
import { EXTRACTION1, SESSION1 } from './fixtures/sessions.js'

let ctx: Awaited<ReturnType<typeof makeApp>>
let llm: FakeLlm
const V = '/api/v1/vaults/dnd'

beforeAll(async () => {
  llm = new FakeLlm([{ match: /Cydia bittet|Notiz/, result: EXTRACTION1 }])
  llm.delayMs = 60_000
  ctx = await makeApp(llm)
})
afterAll(async () => ctx?.cleanup())

async function req(method: string, url: string, body?: any) {
  const res = await ctx.app.inject({ method: method as any, url, payload: body, headers: ctx.auth })
  return { status: res.statusCode, json: res.json() as any }
}

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() - t0 > ms) throw new Error('Zeitüberschreitung')
    await new Promise((r) => setTimeout(r, 30))
  }
}

describe('Kurator stoppen', () => {
  it('Status zeigt den laufenden Lauf, Stoppen bricht ab, nichts wird geschrieben', async () => {
    const r = await req('POST', `${V}/inbox`, SESSION1)
    const st = await waitFor(() => req('GET', `${V}/curator/status`).then((x) => x.json), (s) => s.running.length === 1)
    expect(st.running[0]).toMatchObject({ inbox_id: r.json.inbox_id, phase: 'Erkennen', title: '2026-10-11 Session 1' })

    const stop = await req('POST', `${V}/curator/stop`)
    expect(stop.json.stopped_running).toBe(1)
    const ib = await waitFor(() => req('GET', `${V}/inbox/${r.json.inbox_id}`).then((x) => x.json), (i) => i.status === 'cancelled')
    expect(ib.error).toMatch(/abgebrochen/i)
    const runs = (await req('GET', `${V}/runs`)).json.items
    expect(runs[0].status).toBe('cancelled')
    expect((await req('GET', `${V}/notes/by-title?title=Zylia`)).status).toBe(404)
    expect((await req('GET', `${V}/curator/status`)).json.running).toHaveLength(0)
    // Job wird nicht erneut versucht
    await new Promise((r2) => setTimeout(r2, 200))
    expect((await req('GET', `${V}/inbox/${r.json.inbox_id}`)).json.status).toBe('cancelled')
  })

  it('Wartende Einträge einzeln abbrechen, danach neu verarbeiten', async () => {
    const a = await req('POST', `${V}/inbox`, { text: 'Notiz eins', curate: 'review' })
    const b = await req('POST', `${V}/inbox`, { text: 'Notiz zwei', curate: 'review' })
    await waitFor(() => req('GET', `${V}/curator/status`).then((x) => x.json), (s) => s.running.length === 1 && s.queued === 1)
    const c = await req('POST', `${V}/inbox/${b.json.inbox_id}/cancel`)
    expect(c.json.status).toBe('cancelled')
    expect((await req('GET', `${V}/inbox/${b.json.inbox_id}`)).json.status).toBe('cancelled')
    expect((await req('POST', `${V}/inbox/${a.json.inbox_id}/cancel`)).json.status).toBe('stopping')
    await waitFor(() => req('GET', `${V}/inbox/${a.json.inbox_id}`).then((x) => x.json), (i) => i.status === 'cancelled')
    // Nicht laufende Einträge lassen sich nicht abbrechen
    expect((await req('POST', `${V}/inbox/${a.json.inbox_id}/cancel`)).status).toBe(409)
    // Neu verarbeiten klappt (jetzt ohne Verzögerung)
    llm.delayMs = 0
    await req('POST', `${V}/inbox/${b.json.inbox_id}/reprocess`)
    await ctx.services.jobs.drain()
    expect((await req('GET', `${V}/inbox/${b.json.inbox_id}`)).json.status).toBe('processed')
  })
})
