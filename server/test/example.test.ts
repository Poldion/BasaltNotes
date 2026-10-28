import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeLlm, makeApp } from './helpers.js'

let ctx: Awaited<ReturnType<typeof makeApp>>
const req = async (method: string, url: string, body?: any) => {
  const r = await ctx.app.inject({ method: method as any, url, payload: body, headers: ctx.auth })
  return { status: r.statusCode, json: r.json() as any }
}

beforeAll(async () => {
  ctx = await makeApp(new FakeLlm([]))
})
afterAll(async () => ctx?.cleanup())

describe('Beispiel-Vault', () => {
  it('legt eine verknüpfte Kampagne an – ohne unaufgelöste Links', async () => {
    const r = await req('POST', '/api/v1/vaults/example')
    expect(r.status).toBe(201)
    const id = r.json.id
    expect(r.json.note_count).toBe(16)
    const B = `/api/v1/vaults/${id}`
    const graph = (await req('GET', `${B}/graph`)).json
    expect(graph.edges.length).toBeGreaterThan(20)
    const camp = (await req('GET', `${B}/campaigns`)).json.items
    expect(camp.map((c: any) => c.title)).toEqual(['Die Nebelküste'])
    // Jeder Link zeigt auf eine vorhandene Notiz
    const v = ctx.services.vaults.get(id)
    const unresolved = ctx.services.db.all<any>('SELECT target FROM links WHERE vault = ?', id).filter((l) => !v.resolveName(l.target))
    expect(unresolved).toEqual([])
    expect((await req('POST', '/api/v1/vaults/example')).status).toBe(409)
  })
})
