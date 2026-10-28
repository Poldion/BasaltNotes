import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeLlm, makeApp } from './helpers.js'

let ctx: Awaited<ReturnType<typeof makeApp>>
let dataDir = ''

beforeAll(async () => {
  // Vaults mit leerem bzw. kaputtem .git-Ordner – vor dem Start ablegen
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'basalt-git-'))
  const leer = path.join(dataDir, 'vaults', 'leer')
  fs.mkdirSync(path.join(leer, '.git'), { recursive: true })
  fs.writeFileSync(path.join(leer, 'Eins.md'), '# Eins\n')
  const kaputt = path.join(dataDir, 'vaults', 'kaputt')
  fs.mkdirSync(path.join(kaputt, '.git'), { recursive: true })
  fs.writeFileSync(path.join(kaputt, '.git', 'HEAD'), 'Unsinn\n')
  fs.writeFileSync(path.join(kaputt, 'Zwei.md'), '# Zwei\n')
  ctx = await makeApp(new FakeLlm([]), { config: { dataDir } })
})
afterAll(async () => ctx?.cleanup())

describe('Vaults mit defektem git-Ordner', () => {
  it('startet trotzdem und öffnet beide Vaults', () => {
    expect(ctx.services.vaults.has('leer')).toBe(true)
    expect(ctx.services.vaults.has('kaputt')).toBe(true)
  })

  it('leerer .git-Ordner wird zu einem Repository ergänzt', () => {
    const v = ctx.services.vaults.get('leer')
    expect(v.git.broken).toBeNull()
    const log = execFileSync('git', ['log', '--format=%s'], { cwd: v.dir, encoding: 'utf8' })
    expect(log).toMatch(/Vault geöffnet/)
  })

  it('kaputtes Repository: Notizen bleiben nutzbar, nur ohne Versionierung', async () => {
    const v = ctx.services.vaults.get('kaputt')
    expect(v.git.broken).toBeTruthy()
    const r = await ctx.app.inject({ method: 'POST', url: '/api/v1/vaults/kaputt/notes', payload: { title: 'Neu' }, headers: ctx.auth })
    expect(r.statusCode).toBe(201)
    expect(await v.flushCommit()).toBeNull()
    expect(fs.readFileSync(path.join(v.dir, '.git', 'HEAD'), 'utf8')).toBe('Unsinn\n')
  })
})
