import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { readFileConfig, updateFileConfig } from '../config.js'
import { ApiError, invalid, notFound } from '../lib/errors.js'
import { readTarGz } from '../lib/tar.js'

/*
 * Plugin-Katalog nach dem Vorbild von HACS: ein offizielles GitHub-Repo plus beliebige eigene Repos.
 * Installiert wird aus GitHub-Releases. Pakete sind nicht signiert – Plugins laufen mit allen Rechten
 * des Servers, darum warnt die Oberfläche vor der Installation und nur Server-Admins dürfen das.
 *
 * Ein Repo enthält entweder catalog.json (mehrere Plugins) oder manifest.json (ein Plugin, das neueste
 * Release liefert das Paket).
 */

export const OFFICIAL_REPO = 'Poldion/BasaltNotes-Plug'

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const ID_RE = /^[a-z][a-z0-9-]{1,40}$/
const MAX_DOWNLOAD = 30 * 1024 * 1024
const CACHE_MS = 10 * 60 * 1000
const TIMEOUT_MS = 20_000

export interface CatalogEntry {
  id: string
  name: string
  version: string
  description: string | null
  author: string | null
  repo: string
  official: boolean
  download: string
  sha256: string | null
  min_app: string | null
}

export interface RepoState {
  repo: string
  official: boolean
  error: string | null
  count: number
}

export interface InstalledInfo {
  id: string
  version: string
  server: boolean
  repo: string | null
}

/** "https://github.com/a/b(.git)" oder "a/b" → "a/b" */
export function parseRepo(input: string): string {
  const clean = String(input ?? '')
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
  if (!REPO_RE.test(clean)) throw invalid('Bitte ein GitHub-Repo angeben (https://github.com/name/repo).')
  return clean
}

/** a < b → negativ; Zusätze wie -beta werden nicht gewertet */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => String(v).split(/[-+]/)[0].split('.').map((x) => Number(x) || 0)
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return d
  }
  return 0
}

export class PluginCatalog {
  /** Austauschbar für Tests */
  fetch: typeof globalThis.fetch = (...args) => globalThis.fetch(...args)
  private cache: { at: number; entries: CatalogEntry[]; repos: RepoState[] } | null = null

  constructor(
    private dataDir: string,
    private pluginDir: string,
  ) {}

  customRepos(): string[] {
    const list = (readFileConfig(this.dataDir) as any).plugin_repos
    return Array.isArray(list) ? list.map(String) : []
  }

  repos(): string[] {
    return [OFFICIAL_REPO, ...this.customRepos().filter((r) => r.toLowerCase() !== OFFICIAL_REPO.toLowerCase())]
  }

  /** Repo hinzufügen: nur, wenn es wirklich Plugins enthält */
  async addRepo(input: string): Promise<string> {
    const repo = parseRepo(input)
    if (this.repos().some((r) => r.toLowerCase() === repo.toLowerCase())) throw new ApiError('conflict', 'Dieses Repo ist schon eingetragen.')
    const entries = await this.readRepo(repo).catch((e) => {
      throw invalid(`Repo lässt sich nicht lesen: ${(e as Error).message}`)
    })
    if (!entries.length) throw invalid('In diesem Repo wurden keine Plugins gefunden.')
    updateFileConfig(this.dataDir, (doc) => doc.set('plugin_repos', [...this.customRepos(), repo]))
    this.cache = null
    return repo
  }

  removeRepo(input: string) {
    const repo = parseRepo(input)
    if (repo.toLowerCase() === OFFICIAL_REPO.toLowerCase()) throw invalid('Das offizielle Repo lässt sich nicht entfernen.')
    const rest = this.customRepos().filter((r) => r.toLowerCase() !== repo.toLowerCase())
    updateFileConfig(this.dataDir, (doc) => doc.set('plugin_repos', rest))
    this.cache = null
  }

  private async get(url: string): Promise<Response> {
    return this.fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'BasaltNotes', accept: '*/*' } })
  }

  private entry(raw: any, repo: string, download: string): CatalogEntry | null {
    if (!raw?.id || !ID_RE.test(String(raw.id)) || !raw.version) return null
    return {
      id: String(raw.id),
      name: String(raw.name ?? raw.id),
      version: String(raw.version),
      description: raw.description ? String(raw.description) : null,
      author: raw.author ? String(raw.author) : null,
      repo,
      official: repo.toLowerCase() === OFFICIAL_REPO.toLowerCase(),
      download,
      sha256: raw.sha256 ? String(raw.sha256).toLowerCase() : null,
      min_app: raw.min_app ? String(raw.min_app) : null,
    }
  }

  /** Pakete kommen nur aus den Releases des Repos, das das Plugin anbietet */
  private releaseUrl(repo: string, tag: string, asset: string): string {
    return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`
  }

  private async readRepo(repo: string): Promise<CatalogEntry[]> {
    const raw = `https://raw.githubusercontent.com/${repo}/HEAD`
    const res = await this.get(`${raw}/catalog.json`)
    if (res.ok) {
      const doc: any = await res.json().catch(() => null)
      if (!Array.isArray(doc?.plugins)) throw new Error('catalog.json ist ungültig')
      return doc.plugins
        .map((p: any) => (p?.tag && p?.asset ? this.entry(p, repo, this.releaseUrl(repo, String(p.tag), String(p.asset))) : null))
        .filter(Boolean) as CatalogEntry[]
    }
    if (res.status !== 404) throw new Error(`GitHub antwortet mit ${res.status}`)
    // Einzelnes Plugin: Manifest im Repo, Paket im neuesten Release
    const mf = await this.get(`${raw}/manifest.json`)
    if (mf.status === 404) throw new Error('Weder catalog.json noch manifest.json gefunden')
    if (!mf.ok) throw new Error(`GitHub antwortet mit ${mf.status}`)
    const manifest: any = await mf.json().catch(() => null)
    const rel = await this.get(`https://api.github.com/repos/${repo}/releases/latest`)
    if (!rel.ok) throw new Error('Das Repo hat noch kein Release')
    const release: any = await rel.json().catch(() => null)
    const asset = (release?.assets ?? []).find((a: any) => String(a?.name).endsWith('.tar.gz'))
    if (!asset) throw new Error('Das neueste Release enthält kein .tar.gz-Paket')
    const version = String(release.tag_name ?? manifest?.version ?? '').replace(/^v/, '')
    const e = this.entry({ ...manifest, version }, repo, this.releaseUrl(repo, String(release.tag_name), String(asset.name)))
    return e ? [e] : []
  }

  /** Alle Repos lesen; ein kaputtes Repo stört die anderen nicht */
  async load(refresh = false): Promise<{ entries: CatalogEntry[]; repos: RepoState[] }> {
    if (!refresh && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache
    const entries: CatalogEntry[] = []
    const repos: RepoState[] = []
    for (const repo of this.repos()) {
      const official = repo === OFFICIAL_REPO
      try {
        const list = await this.readRepo(repo)
        for (const e of list) if (!entries.some((x) => x.id === e.id)) entries.push(e)
        repos.push({ repo, official, error: null, count: list.length })
      } catch (e) {
        repos.push({ repo, official, error: (e as Error).message, count: 0 })
      }
    }
    this.cache = { at: Date.now(), entries, repos }
    return this.cache
  }

  /** Was unter <data>/plugins liegt (auch, was erst nach dem Neustart aktiv wird) */
  installed(): InstalledInfo[] {
    if (!fs.existsSync(this.pluginDir)) return []
    const sources = ((readFileConfig(this.dataDir) as any).plugins ?? {}) as Record<string, any>
    const out: InstalledInfo[] = []
    for (const name of fs.readdirSync(this.pluginDir)) {
      if (name.startsWith('.')) continue
      try {
        const m = JSON.parse(fs.readFileSync(path.join(this.pluginDir, name, 'manifest.json'), 'utf8'))
        out.push({ id: m.id, version: String(m.version ?? '0.0.0'), server: !!m.server, repo: sources[m.id]?.source?.repo ?? null })
      } catch {
        // kein Plugin-Ordner
      }
    }
    return out
  }

  /** Paket laden, prüfen und an seinen Platz legen; das vorige bleibt bis zum Schluss unangetastet */
  async install(entry: CatalogEntry, appVersion: string): Promise<{ manifest: any; dir: string }> {
    if (entry.min_app && compareVersions(appVersion, entry.min_app) < 0) throw invalid(`Dieses Plugin braucht BasaltNotes ${entry.min_app} oder neuer.`)
    const res = await this.get(entry.download).catch((e) => {
      throw new ApiError('conflict', `Download fehlgeschlagen: ${(e as Error).message}`)
    })
    if (!res.ok) throw new ApiError('conflict', `Download fehlgeschlagen (${res.status}).`)
    const data = Buffer.from(await res.arrayBuffer())
    if (data.length > MAX_DOWNLOAD) throw invalid('Das Paket ist zu groß.')
    if (entry.sha256 && createHash('sha256').update(data).digest('hex') !== entry.sha256) throw invalid('Die Prüfsumme des Pakets stimmt nicht.')

    const files = readTarGz(data)
    // manifest.json darf im Paket-Wurzelordner oder in einem einzigen Unterordner liegen
    const mfFile = files.filter((f) => /^([^/]+\/)?manifest\.json$/.test(f.path)).sort((a, b) => a.path.length - b.path.length)[0]
    if (!mfFile) throw invalid('Im Paket fehlt manifest.json.')
    const root = mfFile.path.slice(0, -'manifest.json'.length)
    let manifest: any
    try {
      manifest = JSON.parse(mfFile.data.toString('utf8'))
    } catch {
      throw invalid('manifest.json im Paket ist ungültig.')
    }
    if (manifest?.id !== entry.id) throw invalid(`Das Paket enthält das Plugin „${manifest?.id}“, nicht „${entry.id}“.`)
    const inside = files.filter((f) => f.path.startsWith(root)).map((f) => ({ rel: f.path.slice(root.length), data: f.data }))
    for (const key of ['server', 'web', 'styles'] as const) {
      if (manifest[key] && !inside.some((f) => f.rel === String(manifest[key]).replace(/^\.\//, ''))) throw invalid(`Im Paket fehlt ${manifest[key]}.`)
    }

    fs.mkdirSync(this.pluginDir, { recursive: true })
    const tmp = path.join(this.pluginDir, `.tmp-${entry.id}-${randomBytes(4).toString('hex')}`)
    try {
      for (const f of inside) {
        if (!f.rel) continue
        const target = path.resolve(tmp, f.rel)
        if (!target.startsWith(tmp + path.sep)) throw invalid('Unzulässiger Pfad im Archiv.')
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, f.data)
      }
      const dir = path.join(this.pluginDir, entry.id)
      const old = `${dir}.old-${randomBytes(4).toString('hex')}`
      const hadOld = fs.existsSync(dir)
      if (hadOld) fs.renameSync(dir, path.join(this.pluginDir, `.${path.basename(old)}`))
      fs.renameSync(tmp, dir)
      if (hadOld) fs.rmSync(path.join(this.pluginDir, `.${path.basename(old)}`), { recursive: true, force: true })
      updateFileConfig(this.dataDir, (doc) => doc.setIn(['plugins', entry.id, 'source'], { repo: entry.repo, version: String(manifest.version ?? entry.version) }))
      return { manifest, dir }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }

  uninstall(id: string) {
    if (!ID_RE.test(id)) throw notFound('Plugin')
    const info = this.installed().find((p) => p.id === id)
    if (!info) throw notFound('Plugin')
    for (const name of fs.readdirSync(this.pluginDir)) {
      if (name.startsWith('.')) continue
      const dir = path.join(this.pluginDir, name)
      try {
        if (JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).id === id) fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // kein Plugin-Ordner
      }
    }
    updateFileConfig(this.dataDir, (doc) => doc.deleteIn(['plugins', id]))
    return info
  }
}
