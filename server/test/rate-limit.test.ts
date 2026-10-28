import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeLlm, makeApp } from './helpers.js'

let ctx: Awaited<ReturnType<typeof makeApp>>

beforeAll(async () => {
  process.env.RATE_LIMIT_PER_MINUTE = '3'
  ctx = await makeApp(new FakeLlm([]))
})
afterAll(async () => {
  delete process.env.RATE_LIMIT_PER_MINUTE
  await ctx?.cleanup()
})

describe('Ratenbegrenzung', () => {
  it('begrenzt nur die API, nie die Seiten der Oberfläche', async () => {
    for (let i = 0; i < 6; i++) {
      const r = await ctx.app.inject({ method: 'GET', url: '/dndrules/note/abc' })
      expect(r.statusCode).not.toBe(429)
    }
    const codes: number[] = []
    for (let i = 0; i < 5; i++) codes.push((await ctx.app.inject({ method: 'GET', url: '/api/v1/vaults', headers: ctx.auth })).statusCode)
    expect(codes).toContain(429)
  })
})
