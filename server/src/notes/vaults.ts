import fs from 'node:fs'
import path from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import { Db } from '../db.js'
import { EventBus } from '../events.js'
import { ApiError, invalid, notFound } from '../lib/errors.js'
import { slugify, toPosix, versionOf } from '../lib/util.js'
import { getPreset, type PresetDef } from './presets.js'
import { Vault } from './vault.js'

export class VaultManager {
  private vaults = new Map<string, Vault>()
  private watchers = new Map<string, FSWatcher>()

  constructor(
    readonly root: string,
    private db: Db,
    private events: EventBus,
    private opts: { commitDelayMs: number; watch: boolean },
  ) {}

  async init(): Promise<void> {
    fs.mkdirSync(this.root, { recursive: true })
    const dirs = fs.readdirSync(this.root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    if (!dirs.length) {
      // Erster Start: Standard-Vault anlegen
      await this.create('Notizen', 'notes')
      return
    }
    for (const d of dirs) {
      // Ein defekter Ordner darf den Start nicht verhindern
      try {
        await this.openVault(d.name)
      } catch (e) {
        console.error(`Vault „${d.name}“ konnte nicht geöffnet werden:`, (e as Error).message)
      }
    }
  }

  private async openVault(id: string): Promise<Vault> {
    const dir = path.join(this.root, id)
    if (!fs.existsSync(path.join(dir, '.basalt', 'vault.yaml'))) Vault.initialize(dir, id, 'empty')
    const v = new Vault(id, dir, this.db, this.events, { commitDelayMs: this.opts.commitDelayMs })
    await v.open()
    this.vaults.set(id, v)
    if (this.opts.watch) this.startWatcher(v)
    return v
  }

  list(): Vault[] {
    return [...this.vaults.values()].sort((a, b) => a.config.name.localeCompare(b.config.name))
  }

  get(id: string): Vault {
    const v = this.vaults.get(id) ?? [...this.vaults.values()].find((x) => slugify(x.config.name) === slugify(id))
    if (!v) throw notFound('Vault')
    return v
  }

  has(id: string): boolean {
    return this.vaults.has(id)
  }

  async create(name: string, preset: string, lang: 'de' | 'en' = 'de'): Promise<Vault> {
    const clean = (name ?? '').trim()
    if (!clean) throw invalid('Name fehlt.')
    if (!getPreset(preset)) throw invalid('Unbekannte Vorlage.')
    const id = slugify(clean)
    if (!id) throw invalid('Ungültiger Name.')
    if (this.vaults.has(id) || fs.existsSync(path.join(this.root, id))) throw new ApiError('conflict', 'Ein Vault mit diesem Namen existiert bereits.')
    const dir = path.join(this.root, id)
    Vault.initialize(dir, clean, preset, lang)
    const v = await this.openVault(id)
    this.events.emit('vault.created', id, { name: clean, preset })
    return v
  }

  /** Beispiel-Vault einer Vorlage anlegen und mit Notizen füllen */
  async createExample(preset: PresetDef): Promise<Vault> {
    if (!preset.example) throw notFound('Beispiel-Vault')
    const v = await this.create(preset.example.name, preset.id)
    for (const n of preset.example.notes) await v.createNote({ type: n.type, title: n.title, frontmatter: n.frontmatter ?? {}, body: n.body })
    await v.flushCommit('Beispiel-Vault angelegt')
    return v
  }

  async rename(id: string, name: string): Promise<Vault> {
    const v = this.get(id)
    if (!name?.trim()) throw invalid('Name fehlt.')
    v.updateConfig({ name: name.trim() })
    return v
  }

  async delete(id: string): Promise<void> {
    const v = this.get(id)
    await this.stopWatcher(v.id)
    await v.flushCommit()
    const trash = path.join(this.root, '..', 'deleted-vaults')
    fs.mkdirSync(trash, { recursive: true })
    fs.renameSync(v.dir, path.join(trash, `${v.id}-${Date.now()}`))
    for (const t of ['notes', 'names', 'links', 'props', 'tags', 'blocks']) this.db.run(`DELETE FROM ${t} WHERE vault = ?`, v.id)
    this.db.run('DELETE FROM notes_fts WHERE vault = ?', v.id)
    this.vaults.delete(v.id)
    this.events.emit('vault.deleted', v.id, {})
  }

  // ------------------------------------------------------------ Dateisystem-Watcher

  private startWatcher(v: Vault) {
    const pending = new Map<string, NodeJS.Timeout>()
    const watcher = watch(v.dir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
      ignored: (p: string) => {
        const rel = toPosix(path.relative(v.dir, p))
        if (!rel) return false
        if (rel === '.basalt' || rel === '.basalt/vault.yaml') return false
        return rel.split('/').some((s) => s.startsWith('.')) || rel.endsWith('.tmp')
      },
    })
    const handle = (kind: 'change' | 'unlink', file: string) => {
      const rel = toPosix(path.relative(v.dir, file))
      if (rel === '.basalt/vault.yaml') {
        v.loadConfig()
        return
      }
      if (!v.isNotePath(rel)) return
      const t = pending.get(rel)
      if (t) clearTimeout(t)
      pending.set(
        rel,
        setTimeout(() => {
          pending.delete(rel)
          void this.onFileEvent(v, kind, rel)
        }, 300),
      )
    }
    watcher.on('add', (f) => handle('change', f))
    watcher.on('change', (f) => handle('change', f))
    watcher.on('unlink', (f) => handle('unlink', f))
    watcher.on('error', (e) => console.error(`[${v.id}] Watcher-Fehler:`, e))
    this.watchers.set(v.id, watcher)
  }

  private async onFileEvent(v: Vault, kind: 'change' | 'unlink', rel: string) {
    try {
      const own = v.ownWrites.get(rel)
      const file = v.abs(rel)
      if (kind === 'unlink' || !fs.existsSync(file)) {
        if (own === 'deleted') {
          v.ownWrites.delete(rel)
          return
        }
        if (fs.existsSync(file)) return
        const id = await v.fileRemoved(rel)
        if (id) {
          this.events.emit('note.deleted', v.id, { note_id: id, path: rel, external: true })
          v.scheduleCommit(`Extern gelöscht: ${rel}`)
        }
        return
      }
      const raw = fs.readFileSync(file, 'utf8')
      if (own && own === versionOf(raw)) {
        v.ownWrites.delete(rel)
        return
      }
      v.ownWrites.delete(rel)
      const existed = !!v.idOfPath(rel)
      const id = await v.indexFile(rel)
      if (!id) return
      const n = v.readNote(id)
      this.events.emit(existed ? 'note.updated' : 'note.created', v.id, {
        note_id: id,
        title: n?.title,
        type: n?.type,
        path: rel,
        version: n?.version,
        external: true,
      })
      v.scheduleCommit(`Extern geändert: ${rel}`)
    } catch (e) {
      console.error(`[${v.id}] Fehler beim Verarbeiten von ${rel}:`, (e as Error).message)
    }
  }

  private async stopWatcher(id: string) {
    const w = this.watchers.get(id)
    if (w) await w.close()
    this.watchers.delete(id)
  }

  async close() {
    for (const id of [...this.watchers.keys()]) await this.stopWatcher(id)
    for (const v of this.vaults.values()) await v.flushCommit()
  }
}
