import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OFFICIAL_REPO, compareVersions, parseRepo } from '../src/plugins/catalog.js'
import { readTarGz } from '../src/lib/tar.js'
import { FakeLlm, makeApp } from './helpers.js'

const A = '/api/v1'
let ctx: Awaited<ReturnType<typeof makeApp>>
const req = async (method: any, url: string, payload?: any, headers: Record<string, string> = ctx.auth) => {
  const r = await ctx.app.inject({ method, url: `${A}${url}`, payload, headers })
  return { status: r.statusCode, json: r.json() as any }
}

/** Kleines tar im Speicher */
function tarGz(files: Record<string, string>, kinds: Record<string, string> = {}) {
  const blocks: Buffer[] = []
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    const h = Buffer.alloc(512)
    h.write(name, 0, 100)
    h.write('0000644\0', 100)
    h.write('0000000\0', 108)
    h.write('0000000\0', 116)
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124)
    h.write('00000000000\0', 136)
    h.write(kinds[name] ?? '0', 156)
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

const webPlugin = (version: string) => tarGz({ 'statistik/manifest.json': JSON.stringify({ id: 'statistik', name: 'Statistik', version, web: 'web.js' }), 'statistik/web.js': 'export default () => {}' })

// Nachgestelltes GitHub
const pages = new Map<string, { status?: number; body: string | Buffer }>()
const catalog = (entries: any[]) => JSON.stringify({ plugins: entries })
const raw = (repo: string, file: string) => `https://raw.githubusercontent.com/${repo}/HEAD/${file}`
const asset = (repo: string, tag: string, name: string) => `https://github.com/${repo}/releases/download/${tag}/${name}`
const setOfficial = (version: string, extra: Record<string, unknown> = {}) => {
  pages.set(raw(OFFICIAL_REPO, 'catalog.json'), { body: catalog([{ id: 'statistik', name: 'Statistik', version, tag: `statistik-${version}`, asset: `statistik-${version}.tar.gz`, ...extra }]) })
  pages.set(asset(OFFICIAL_REPO, `statistik-${version}`, `statistik-${version}.tar.gz`), { body: webPlugin(version) })
}

beforeAll(async () => {
  ctx = await makeApp(new FakeLlm([]))
  ctx.services.plugins!.catalog.fetch = (async (url: any) => {
    const p = pages.get(String(url))
    return new Response(p?.body ?? 'nicht gefunden', { status: p ? (p.status ?? 200) : 404 })
  }) as any
})
afterAll(async () => ctx?.cleanup())

describe('Plugin-Katalog', () => {
  it('Installiert aus dem offiziellen Repo, sofort aktiv ohne Neustart', async () => {
    setOfficial('1.0.0')
    const before = await req('GET', '/plugins/catalog?refresh=1')
    expect(before.json.repos[0]).toMatchObject({ repo: OFFICIAL_REPO, official: true, error: null, count: 1 })
    expect(before.json.items[0]).toMatchObject({ id: 'statistik', installed: null, update: false, official: true })

    const inst = await req('POST', '/plugins/install', { id: 'statistik' })
    expect(inst.json).toEqual({ id: 'statistik', version: '1.0.0', restart_required: false })
    const list = (await req('GET', '/plugins')).json.items
    expect(list.find((p: any) => p.id === 'statistik')).toMatchObject({ enabled: true, builtin: false, repo: OFFICIAL_REPO })
    expect((await ctx.app.inject({ method: 'GET', url: '/plugins/statistik/web.js' })).statusCode).toBe(200)
  })

  it('Zeigt Updates an und spielt sie ein', async () => {
    setOfficial('1.1.0')
    const c = await req('GET', '/plugins/catalog?refresh=1')
    expect(c.json.items[0]).toMatchObject({ installed: '1.0.0', version: '1.1.0', update: true })
    expect((await req('POST', '/plugins/install', { id: 'statistik' })).json.version).toBe('1.1.0')
    expect((await req('GET', '/plugins')).json.items.find((p: any) => p.id === 'statistik').version).toBe('1.1.0')
    expect((await req('GET', '/plugins/catalog?refresh=1')).json.items[0].update).toBe(false)
  })

  it('Server-Plugin braucht einen Neustart', async () => {
    const pkg = tarGz({ 'manifest.json': JSON.stringify({ id: 'mitserver', version: '1.0.0', server: 'server.js' }), 'server.js': 'export default {}' })
    pages.set(raw(OFFICIAL_REPO, 'catalog.json'), { body: catalog([{ id: 'mitserver', version: '1.0.0', tag: 't1', asset: 'm.tar.gz' }]) })
    pages.set(asset(OFFICIAL_REPO, 't1', 'm.tar.gz'), { body: pkg })
    expect((await req('POST', '/plugins/install', { id: 'mitserver' })).json.restart_required).toBe(true)
    const c = await req('GET', '/plugins/catalog?refresh=1')
    expect(c.json.restart_required).toContain('mitserver')
    expect(c.json.items[0].installed).toBe('1.0.0')
    expect((await req('DELETE', '/plugins/mitserver')).status).toBe(200)
  })

  it('Lehnt fremde, beschädigte und gefälschte Pakete ab', async () => {
    const bad = async (body: Buffer, extra: Record<string, unknown> = {}) => {
      pages.set(raw(OFFICIAL_REPO, 'catalog.json'), { body: catalog([{ id: 'boese', version: '1.0.0', tag: 'x', asset: 'x.tar.gz', ...extra }]) })
      pages.set(asset(OFFICIAL_REPO, 'x', 'x.tar.gz'), { body })
      return req('POST', '/plugins/install', { id: 'boese' })
    }
    const good = tarGz({ 'manifest.json': JSON.stringify({ id: 'boese', version: '1.0.0' }) })
    expect((await bad(Buffer.from('kein archiv'))).status).toBe(400)
    expect((await bad(tarGz({ '../../boese/manifest.json': '{}', 'manifest.json': '{"id":"boese"}' }))).status).toBe(400)
    expect((await bad(tarGz({ 'manifest.json': '{"id":"boese"}', link: 'x' }, { link: '2' }))).status).toBe(400)
    expect((await bad(tarGz({ 'manifest.json': '{"id":"anderes"}' }))).status).toBe(400)
    expect((await bad(tarGz({ 'manifest.json': '{"id":"boese","server":"fehlt.js"}' }))).status).toBe(400)
    expect((await bad(good, { sha256: 'abc' })).status).toBe(400)
    expect((await bad(good, { sha256: createHash('sha256').update(good).digest('hex'), min_app: '99.0.0' })).status).toBe(400)
    expect(fs.existsSync(path.join(ctx.dataDir, 'plugins', 'boese'))).toBe(false)
    expect(fs.readdirSync(path.join(ctx.dataDir, 'plugins')).filter((n) => n.startsWith('.'))).toEqual([])
    expect((await bad(good, { sha256: createHash('sha256').update(good).digest('hex') })).status).toBe(200)
    expect((await req('DELETE', '/plugins/boese')).status).toBe(200)
  })

  it('Eigene Repos: eintragen, mit einzelnem Plugin, austragen', async () => {
    const repo = 'jemand/mein-plugin'
    expect((await req('POST', '/plugins/repos', { url: 'kein repo!' })).status).toBe(400)
    expect((await req('POST', '/plugins/repos', { url: `https://github.com/${repo}` })).status).toBe(400)
    pages.set(raw(repo, 'manifest.json'), { body: JSON.stringify({ id: 'eigenes', name: 'Eigenes', version: '0.0.0', web: 'web.js' }) })
    pages.set(`https://api.github.com/repos/${repo}/releases/latest`, { body: JSON.stringify({ tag_name: 'v2.0.0', assets: [{ name: 'eigenes.tar.gz' }] }) })
    pages.set(asset(repo, 'v2.0.0', 'eigenes.tar.gz'), { body: tarGz({ 'manifest.json': JSON.stringify({ id: 'eigenes', version: '2.0.0', web: 'web.js' }), 'web.js': '' }) })
    expect((await req('POST', '/plugins/repos', { url: `https://github.com/${repo}.git` })).json.repo).toBe(repo)
    expect((await req('POST', '/plugins/repos', { url: repo })).status).toBe(409)
    const c = await req('GET', '/plugins/catalog?refresh=1')
    expect(c.json.items.find((i: any) => i.id === 'eigenes')).toMatchObject({ version: '2.0.0', official: false, repo })
    expect((await req('POST', '/plugins/install', { id: 'eigenes' })).status).toBe(200)
    expect((await req('DELETE', '/plugins/repos', { url: OFFICIAL_REPO })).status).toBe(400)
    expect((await req('DELETE', '/plugins/repos', { url: repo })).status).toBe(200)
    expect((await req('GET', '/plugins/catalog?refresh=1')).json.repos.map((r: any) => r.repo)).toEqual([OFFICIAL_REPO])
  })

  it('Repo ohne Plugins wird abgelehnt', async () => {
    const repo = 'leer/repo'
    pages.set(raw(repo, 'catalog.json'), { body: catalog([]) })
    expect((await req('POST', '/plugins/repos', { url: repo })).status).toBe(400)
  })

  it('Ein kaputtes Repo stört die anderen nicht', async () => {
    const repo = 'kaputt/repo'
    pages.set(raw(repo, 'catalog.json'), { body: catalog([{ id: 'heil', version: '1.0.0', tag: 'a', asset: 'a.tar.gz' }]) })
    expect((await req('POST', '/plugins/repos', { url: repo })).status).toBe(201)
    pages.set(raw(repo, 'catalog.json'), { status: 500, body: 'kaputt' })
    setOfficial('1.1.0')
    const c = await req('GET', '/plugins/catalog?refresh=1')
    expect(c.json.items.map((i: any) => i.id)).toEqual(['statistik'])
    expect(c.json.repos.find((r: any) => r.repo === repo).error).toMatch(/500/)
    await req('DELETE', '/plugins/repos', { url: repo })
  })

  it('Entfernen wirkt sofort; Mitgeliefertes bleibt; nur Server-Admins', async () => {
    expect((await req('DELETE', '/plugins/statistik')).status).toBe(200)
    expect((await req('GET', '/plugins')).json.items.some((p: any) => p.id === 'statistik')).toBe(false)
    expect((await ctx.app.inject({ method: 'GET', url: '/plugins/statistik/web.js' })).statusCode).toBe(404)
    expect((await req('DELETE', '/plugins/calendar')).status).toBe(400)
    expect((await req('POST', '/plugins/install', { id: 'calendar' })).status).toBe(400)

    const t = ctx.services.auth.createToken({ name: 'x', grants: [{ vault: 'notizen', access: 'admin' }] } as any)
    const h = { authorization: `Bearer ${t.token}` }
    expect((await req('GET', '/plugins/catalog', undefined, h)).status).toBe(403)
    expect((await req('POST', '/plugins/install', { id: 'statistik' }, h)).status).toBe(403)
    expect((await req('PUT', '/plugins/calendar', { enabled: false }, h)).status).toBe(403)
  })

  it('Hilfsfunktionen', () => {
    expect(parseRepo('https://github.com/a/b.git/')).toBe('a/b')
    expect(() => parseRepo('https://evil.example/a/b')).toThrow()
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(readTarGz(tarGz({ './a/b.txt': 'x' }))[0].path).toBe('a/b.txt')
  })
})

describe('D&D als Plugin', () => {
  it('Ausgeschaltet: keine Kampagnen, keine Spieler-Rolle; bestehende Spieler bleiben eingeschränkt', async () => {
    const u = await req('POST', '/users', { username: 'sp', password: 'geheim-12345', role: 'player', vaults: ['dnd'] })
    expect(u.status).toBe(201)
    await req('POST', '/vaults/dnd/notes', { type: 'campaign', title: 'Testrunde', frontmatter: { visibility: 'players' } })
    expect((await req('GET', '/vaults/dnd/campaigns')).json.items.map((c: any) => c.title)).toContain('Testrunde')
    await req('PUT', '/plugins/dnd', { enabled: false })
    expect((await req('GET', '/vaults/dnd/campaigns')).status).toBe(404)
    expect((await req('POST', '/users', { username: 'sp2', password: 'geheim-12345', role: 'player' })).status).toBe(400)
    expect((await req('GET', '/users')).json.roles.map((r: any) => r.name)).not.toContain('player')
    const login = await ctx.app.inject({ method: 'POST', url: `${A}/auth/login`, payload: { username: 'sp', password: 'geheim-12345' } })
    const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ')
    expect((await req('GET', '/auth/me', undefined, { cookie })).json.visibility).toBe('players')
    await req('PUT', '/plugins/dnd', { enabled: true })
    expect((await req('GET', '/vaults/dnd/campaigns')).status).toBe(200)
  })

  it('Eingeschränkte Zugänge dürfen die Plugin-Liste lesen (Spieler-Links laden die Kampagnenseite)', async () => {
    const t = ctx.services.auth.createToken({ name: 'share', vaults: ['dnd'], scopes: ['read'], visibility: 'players', campaign: 'Testrunde', kind: 'share' } as any)
    const h = { authorization: `Bearer ${t.token}` }
    expect((await req('GET', '/plugins', undefined, h)).status).toBe(200)
    expect((await req('GET', '/vaults/dnd/campaigns/testrunde/overview', undefined, h)).status).toBe(200)
  })
})
