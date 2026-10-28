import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { ulid } from 'ulid'
import { Db, nowIso, json } from '../db.js'
import { Git } from '../git.js'
import { EventBus } from '../events.js'
import { ApiError, invalid, notFound } from '../lib/errors.js'
import { Mutex, norm, safeFileName, safeJoin, toPosix, versionOf, writeFileAtomic } from '../lib/util.js'
import {
  composeNote,
  contextAround,
  extractLinks,
  extractTags,
  listBlocks,
  mergeFrontmatterText,
  parseNote,
  removeBlock,
  replaceLinks,
  setBlock,
  stripDmBlocks,
  stringifyFrontmatter,
  headings,
  type BlockInput,
} from './markdown.js'
import { ADDED_TYPES, COMMON_PROPS, DEFAULT_CURATOR, DND_TYPES, EMPTY_TYPES, NOTES_TYPES, PRESET_TYPES, PRESET_REVISION, TEMPLATES, presetConfig, presetYaml, type PropDef, type TypeDef, type VaultConfig } from './presets.js'

export interface Note {
  id: string
  vault: string
  path: string
  type: string
  title: string
  aliases: string[]
  tags: string[]
  campaign: string | null
  visibility: string | null
  frontmatter: Record<string, any>
  body: string
  raw: string
  version: string
  created: string | null
  updated: string | null
}

export interface CreateNoteInput {
  type?: string
  title: string
  frontmatter?: Record<string, any>
  body?: string
  folder?: string
  template?: string
  id?: string
}

export interface WriteOptions {
  /** Kein Ereignis/Commit (z. B. innerhalb eines Kurator-Laufs, der selbst committet) */
  silent?: boolean
  commitMessage?: string
  touchUpdated?: boolean
}

const IGNORED_DIRS = new Set(['.git', '.basalt', '.trash', '.obsidian', 'node_modules'])
const RESERVED_FM = new Set(['id', 'type', 'title', 'aliases', 'created', 'updated'])
/** Ordner auf oberster Ebene, die keine Notizen enthalten (Anhänge, Rohdaten des Eingangs) */
const NON_NOTE_DIRS = new Set(['_attachments', '_inbox'])

export function stripLink(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (Array.isArray(v)) return v.length ? stripLink(v[0]) : null
  const s = String(v).trim()
  const m = /^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$/.exec(s)
  return (m ? m[1] : s).trim() || null
}

function toList(v: unknown): string[] {
  if (v === null || v === undefined || v === '') return []
  if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined && x !== '').map((x) => String(x))
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function isoOf(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  if (v instanceof Date) return v.toISOString()
  return String(v)
}

export class Vault {
  config!: VaultConfig
  readonly git: Git
  private mutex = new Mutex()
  /** Zuletzt selbst geschriebene Dateien (Pfad → Version), damit der Watcher sie ignoriert. */
  readonly ownWrites = new Map<string, string>()
  private commitTimer: NodeJS.Timeout | null = null
  private pendingMessages: string[] = []

  constructor(
    readonly id: string,
    readonly dir: string,
    private db: Db,
    private events: EventBus,
    private opts: { commitDelayMs: number },
  ) {
    this.git = new Git(dir)
  }

  // ------------------------------------------------------------ Setup & Konfiguration

  get configFile() {
    return path.join(this.dir, '.basalt', 'vault.yaml')
  }

  async open(): Promise<void> {
    fs.mkdirSync(path.join(this.dir, '.basalt', 'templates'), { recursive: true })
    fs.mkdirSync(path.join(this.dir, '_inbox'), { recursive: true })
    fs.mkdirSync(path.join(this.dir, '_attachments'), { recursive: true })
    this.loadConfig()
    await this.git.init()
    if (this.git.broken) console.warn(`[${this.id}] git-Verlauf nicht nutzbar (${this.git.broken}) – Änderungen werden nicht versioniert. Ordner ${path.join(this.dir, '.git')} prüfen.`)
    await this.reindex()
    await this.git.commitAll('Vault geöffnet').catch((e) => console.error(`[${this.id}] Commit fehlgeschlagen:`, (e as Error).message))
  }

  /** Neuen Vault anlegen; lang bestimmt die Ordnernamen der Vorlage (Typen und Werte bleiben gleich) */
  static initialize(dir: string, name: string, preset: string, lang: 'de' | 'en' = 'de'): void {
    fs.mkdirSync(path.join(dir, '.basalt', 'templates'), { recursive: true })
    const cfg = presetConfig(name, preset, lang)
    writeFileAtomic(path.join(dir, '.basalt', 'vault.yaml'), YAML.stringify(presetYaml(cfg), { lineWidth: 0 }))
    for (const [typeName, t] of Object.entries(cfg.types)) {
      if (!t.template) continue
      const file = path.join(dir, '.basalt', 'templates', `${t.template}.md`)
      if (!fs.existsSync(file) && TEMPLATES[t.template]) writeFileAtomic(file, TEMPLATES[t.template])
      void typeName
    }
  }

  loadConfig(): VaultConfig {
    let raw: any = {}
    if (fs.existsSync(this.configFile)) {
      try {
        raw = YAML.parse(fs.readFileSync(this.configFile, 'utf8')) ?? {}
      } catch {
        raw = {}
      }
    }
    const preset = raw.preset ?? 'dnd'
    const base = preset === 'notes' ? NOTES_TYPES : preset === 'empty' ? EMPTY_TYPES : DND_TYPES
    // Neue Standardtypen in ältere Vaults übernehmen (einmalig je Revision)
    if (raw.types && (raw.preset_revision ?? 1) < PRESET_REVISION) {
      const doc = YAML.parseDocument(fs.readFileSync(this.configFile, 'utf8'))
      for (let rev = (raw.preset_revision ?? 1) + 1; rev <= PRESET_REVISION; rev++) {
        for (const name of ADDED_TYPES[rev]?.[preset] ?? []) {
          const def = (base as Record<string, TypeDef>)[name]
          if (!def || raw.types[name]) continue
          const { properties: _p, label: _l, ...rest } = def
          doc.setIn(['types', name], rest)
          raw.types[name] = rest
          if (def.template) {
            const tf = path.join(this.dir, '.basalt', 'templates', `${def.template}.md`)
            if (!fs.existsSync(tf) && TEMPLATES[def.template]) writeFileAtomic(tf, TEMPLATES[def.template])
          }
        }
      }
      doc.set('preset_revision', PRESET_REVISION)
      writeFileAtomic(this.configFile, doc.toString({ lineWidth: 0 }))
    }
    const types: Record<string, TypeDef> = {}
    const fileTypes: Record<string, TypeDef> = raw.types ?? base
    for (const [k, t] of Object.entries(fileTypes)) {
      const b = (base as Record<string, TypeDef>)[k] ?? {}
      types[k] = { ...b, ...(t ?? {}), properties: (t as TypeDef)?.properties ?? b.properties ?? [] }
    }
    if (!types.note) types.note = { label: 'Notiz', folder: '', properties: [] }
    this.config = {
      name: raw.name ?? this.id,
      preset,
      types,
      curator: { ...DEFAULT_CURATOR, profile: preset === 'dnd' ? 'dnd' : 'notes', ...(raw.curator ?? {}) },
    }
    return this.config
  }

  rawConfigText(): string {
    return fs.existsSync(this.configFile) ? fs.readFileSync(this.configFile, 'utf8') : ''
  }

  saveConfigText(text: string): void {
    YAML.parse(text) // wirft bei ungültigem YAML
    writeFileAtomic(this.configFile, text)
    this.loadConfig()
    this.scheduleCommit('Vault-Einstellungen geändert')
  }

  updateConfig(changes: Record<string, any>): void {
    const doc = fs.existsSync(this.configFile) ? YAML.parseDocument(fs.readFileSync(this.configFile, 'utf8')) : new YAML.Document({})
    for (const [k, v] of Object.entries(changes)) doc.set(k, v)
    writeFileAtomic(this.configFile, doc.toString({ lineWidth: 0 }))
    this.loadConfig()
    this.scheduleCommit('Vault-Einstellungen geändert')
  }

  typeDef(type: string): TypeDef {
    return this.config.types[type] ?? { label: type, folder: '', properties: [] }
  }

  /** Typ anlegen/ändern (in vault.yaml, Kommentare bleiben erhalten); optional Vorlage als Markdown */
  setType(name: string, def: { label: string; folder: string; properties: PropDef[] }, templateBody?: string | null): void {
    const doc = fs.existsSync(this.configFile) ? YAML.parseDocument(fs.readFileSync(this.configFile, 'utf8')) : new YAML.Document({})
    const cur = (doc.getIn(['types', name]) as any)?.toJSON?.() ?? {}
    const next: Record<string, any> = { ...cur, label: def.label, folder: def.folder, properties: def.properties }
    if (templateBody !== undefined) {
      if (templateBody === null || !templateBody.trim()) delete next.template
      else {
        const tname = cur.template ?? name
        fs.mkdirSync(path.join(this.dir, '.basalt', 'templates'), { recursive: true })
        writeFileAtomic(path.join(this.dir, '.basalt', 'templates', `${tname}.md`), templateBody.endsWith('\n') ? templateBody : templateBody + '\n')
        next.template = tname
      }
    }
    doc.setIn(['types', name], next)
    writeFileAtomic(this.configFile, doc.toString({ lineWidth: 0 }))
    this.loadConfig()
    this.scheduleCommit(`Typ „${def.label}“ gespeichert`)
  }

  /** Typ entfernen (nur wenn keine Notiz ihn benutzt) */
  deleteType(name: string): void {
    const doc = YAML.parseDocument(fs.readFileSync(this.configFile, 'utf8'))
    doc.deleteIn(['types', name])
    writeFileAtomic(this.configFile, doc.toString({ lineWidth: 0 }))
    this.loadConfig()
    this.scheduleCommit(`Typ „${name}“ entfernt`)
  }

  /** Inhalt der Vorlage eines Typs */
  templateText(type: string): string | null {
    const t = this.config.types[type]?.template
    if (!t) return null
    const file = path.join(this.dir, '.basalt', 'templates', `${t}.md`)
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : (TEMPLATES[t] ?? null)
  }

  typesSchema() {
    return Object.entries(this.config.types).map(([name, t]) => ({
      name,
      label: t.label ?? name,
      folder: t.folder ?? '',
      template: t.template ?? null,
      single_note: t.single_note ?? null,
      builtin: !!(PRESET_TYPES[this.config.preset ?? '']?.[name]),
      // Sichtbarkeit (DM/Spieler) gibt es nur in D&D-Vaults
      properties: [...(t.properties ?? []), ...COMMON_PROPS.filter((p) => p.name !== 'visibility' || this.config.curator.profile === 'dnd')],
    }))
  }

  // ------------------------------------------------------------ Dateien

  abs(rel: string): string {
    return safeJoin(this.dir, rel)
  }

  listFiles(sub = ''): string[] {
    const out: string[] = []
    const walk = (dir: string) => {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.name.startsWith('.') && (IGNORED_DIRS.has(e.name) || e.isDirectory())) continue
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (dir === this.dir && NON_NOTE_DIRS.has(e.name)) continue
          walk(full)
        } else if (e.isFile() && e.name.toLowerCase().endsWith('.md') && !e.name.startsWith('.')) out.push(toPosix(path.relative(this.dir, full)))
      }
    }
    walk(path.join(this.dir, sub))
    return out.sort()
  }

  listFolders(): string[] {
    const out: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith('.') || IGNORED_DIRS.has(e.name) || (dir === this.dir && NON_NOTE_DIRS.has(e.name))) continue
        const full = path.join(dir, e.name)
        out.push(toPosix(path.relative(this.dir, full)))
        walk(full)
      }
    }
    walk(this.dir)
    return out.sort()
  }

  isNotePath(rel: string): boolean {
    const parts = rel.split('/')
    if (parts.some((p) => p.startsWith('.')) || NON_NOTE_DIRS.has(parts[0])) return false
    return rel.toLowerCase().endsWith('.md')
  }

  private writeRaw(rel: string, raw: string): string {
    const version = versionOf(raw)
    this.ownWrites.set(rel, version)
    writeFileAtomic(this.abs(rel), raw)
    return version
  }

  // ------------------------------------------------------------ Index

  async reindex(): Promise<{ notes: number; ms: number }> {
    return this.mutex.run(() => {
      const t0 = Date.now()
      const files = this.listFiles()
      this.db.tx(() => {
        for (const t of ['notes', 'names', 'links', 'props', 'tags', 'blocks']) this.db.run(`DELETE FROM ${t} WHERE vault = ?`, this.id)
        this.db.run('DELETE FROM notes_fts WHERE vault = ?', this.id)
        const seen = new Set<string>()
        for (const rel of files) {
          try {
            const id = this.indexFileUnlocked(rel, seen)
            if (id) seen.add(id)
          } catch (e) {
            console.error(`[${this.id}] Index-Fehler bei ${rel}:`, (e as Error).message)
          }
        }
      })
      return { notes: files.length, ms: Date.now() - t0 }
    })
  }

  /** Datei (neu) indizieren. Fehlt die ID, wird sie ergänzt. Gibt die Notiz-ID zurück. */
  indexFile(rel: string): Promise<string | null> {
    return this.mutex.run(() => this.indexFileUnlocked(rel))
  }

  private indexFileUnlocked(rel: string, seenIds?: Set<string>): string | null {
    const file = this.abs(rel)
    if (!fs.existsSync(file)) {
      this.removeFromIndexByPath(rel)
      return null
    }
    let raw = fs.readFileSync(file, 'utf8')
    let parsed = parseNote(raw)
    let id = parsed.frontmatter.id ? String(parsed.frontmatter.id) : ''
    const existingOther = id ? this.db.get<{ path: string }>('SELECT path FROM notes WHERE vault = ? AND id = ?', this.id, id) : undefined
    const duplicate = (id && seenIds?.has(id)) || (existingOther && existingOther.path !== rel && fs.existsSync(this.abs(existingOther.path)))
    if (!id || duplicate) {
      // ID ergänzen (Datei von außen angelegt oder kopiert)
      id = ulid()
      const fmText = mergeFrontmatterText(parsed.fmText, { id })
      raw = composeNote(fmText, parsed.body)
      this.writeRaw(rel, raw)
      parsed = parseNote(raw)
    }
    const stat = fs.statSync(file)
    this.upsertIndex(rel, id, raw, parsed, stat.mtimeMs)
    return id
  }

  private upsertIndex(rel: string, id: string, raw: string, parsed: ReturnType<typeof parseNote>, mtime: number) {
    const fm = parsed.frontmatter
    const title = fm.title ? String(fm.title) : path.basename(rel).replace(/\.md$/i, '')
    const type = fm.type ? String(fm.type) : 'note'
    const campaign = type === 'campaign' ? title : stripLink(fm.campaign)
    const aliases = toList(fm.aliases)
    const tags = [...new Set([...toList(fm.tags).map((t) => t.replace(/^#/, '')), ...extractTags(parsed.body)])]
    const visibility = fm.visibility ? String(fm.visibility) : null
    const version = versionOf(raw)
    this.removeFromIndex(id)
    this.removeFromIndexByPath(rel)
    this.db.run(
      `INSERT INTO notes (vault, id, path, type, title, campaign, visibility, frontmatter, body, version, created, updated, mtime)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      this.id,
      id,
      rel,
      type,
      title,
      campaign,
      visibility,
      JSON.stringify(fm, (_k, v) => (v instanceof Date ? v.toISOString() : v)),
      parsed.body,
      version,
      isoOf(fm.created),
      isoOf(fm.updated) ?? new Date(mtime).toISOString(),
      mtime,
    )
    this.db.run(
      'INSERT INTO notes_fts (vault, id, title, aliases, body, body_public) VALUES (?,?,?,?,?,?)',
      this.id,
      id,
      title,
      aliases.join(' '),
      parsed.body,
      stripDmBlocks(parsed.body),
    )
    // Bereiche mit visibility="dm": Links darin sind DM-Wissen
    const dmRanges = listBlocks(parsed.body)
      .filter((b) => b.attrs.visibility === 'dm')
      .map((b) => [b.start, b.end] as const)
    const inDm = (pos: number) => dmRanges.some(([a, b]) => pos >= a && pos < b)
    const names = new Map<string, [string, string]>()
    const addName = (display: string, kind: string) => {
      const n = norm(display)
      if (n && !names.has(n)) names.set(n, [display, kind])
    }
    addName(title, 'title')
    addName(path.basename(rel).replace(/\.md$/i, ''), 'file')
    addName(rel.replace(/\.md$/i, ''), 'path')
    for (const a of aliases) addName(a, 'alias')
    for (const [n, [display, kind]] of names) this.db.run('INSERT INTO names (vault, note_id, norm, display, kind) VALUES (?,?,?,?,?)', this.id, id, n, display, kind)
    for (const l of extractLinks(parsed.body)) {
      if (!l.target) continue
      this.db.run(
        'INSERT INTO links (vault, source_id, target, target_norm, heading, display, embed, line, context, dm) VALUES (?,?,?,?,?,?,?,?,?,?)',
        this.id,
        id,
        l.target,
        norm(l.target),
        l.heading,
        l.display,
        l.embed ? 1 : 0,
        l.line,
        contextAround(parsed.body, l.index),
        inDm(l.index) ? 1 : 0,
      )
    }
    // Links in Eigenschaften (z. B. parent: "[[Barovia]]")
    for (const [k, v] of Object.entries(fm)) {
      if (RESERVED_FM.has(k)) continue
      for (const item of Array.isArray(v) ? v : [v]) {
        if (typeof item !== 'string') continue
        for (const l of extractLinks(item)) {
          this.db.run(
            'INSERT INTO links (vault, source_id, target, target_norm, heading, display, embed, line, context) VALUES (?,?,?,?,?,?,?,?,?)',
            this.id,
            id,
            l.target,
            norm(l.target),
            l.heading,
            l.display,
            0,
            0,
            `${k}: ${item}`,
          )
        }
      }
    }
    for (const [k, v] of Object.entries(fm)) {
      if (k === 'id') continue
      const values = Array.isArray(v) ? v : [v]
      for (const item of values) {
        if (item === null || item === undefined) continue
        const s = typeof item === 'object' && !(item instanceof Date) ? JSON.stringify(item) : item instanceof Date ? item.toISOString() : String(item)
        this.db.run('INSERT INTO props (vault, note_id, key, value) VALUES (?,?,?,?)', this.id, id, k, stripLink(s) ?? s)
      }
    }
    for (const t of tags) this.db.run('INSERT INTO tags (vault, note_id, tag) VALUES (?,?,?)', this.id, id, t)
    for (const b of listBlocks(parsed.body)) {
      this.db.run(
        'INSERT INTO blocks (vault, note_id, key, source_note, visibility, updated) VALUES (?,?,?,?,?,?)',
        this.id,
        id,
        b.key,
        b.attrs.source ?? null,
        b.attrs.visibility ?? null,
        b.attrs.updated ?? null,
      )
    }
  }

  private removeFromIndex(id: string) {
    for (const t of ['notes']) this.db.run(`DELETE FROM ${t} WHERE vault = ? AND id = ?`, this.id, id)
    this.db.run('DELETE FROM notes_fts WHERE vault = ? AND id = ?', this.id, id)
    for (const t of ['names', 'props', 'tags', 'blocks']) this.db.run(`DELETE FROM ${t} WHERE vault = ? AND note_id = ?`, this.id, id)
    this.db.run('DELETE FROM links WHERE vault = ? AND source_id = ?', this.id, id)
  }

  private removeFromIndexByPath(rel: string) {
    const row = this.db.get<{ id: string }>('SELECT id FROM notes WHERE vault = ? AND path = ?', this.id, rel)
    if (row) this.removeFromIndex(row.id)
  }

  /** Datei wurde von außen gelöscht. */
  async fileRemoved(rel: string): Promise<string | null> {
    return this.mutex.run(() => {
      const row = this.db.get<{ id: string }>('SELECT id FROM notes WHERE vault = ? AND path = ?', this.id, rel)
      if (row) this.removeFromIndex(row.id)
      return row?.id ?? null
    })
  }

  // ------------------------------------------------------------ Lesen

  count(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) n FROM notes WHERE vault = ?', this.id)?.n ?? 0
  }

  pathOf(id: string): string | null {
    return this.db.get<{ path: string }>('SELECT path FROM notes WHERE vault = ? AND id = ?', this.id, id)?.path ?? null
  }

  idOfPath(rel: string): string | null {
    return this.db.get<{ id: string }>('SELECT id FROM notes WHERE vault = ? AND path = ?', this.id, rel)?.id ?? null
  }

  readNote(id: string): Note | null {
    const rel = this.pathOf(id)
    if (!rel) return null
    const file = this.abs(rel)
    if (!fs.existsSync(file)) return null
    return this.buildNote(id, rel, fs.readFileSync(file, 'utf8'))
  }

  getNote(id: string): Note {
    const n = this.readNote(id)
    if (!n) throw notFound('Notiz')
    return n
  }

  buildNote(id: string, rel: string, raw: string): Note {
    const parsed = parseNote(raw)
    const fm = parsed.frontmatter
    const title = fm.title ? String(fm.title) : path.basename(rel).replace(/\.md$/i, '')
    const type = fm.type ? String(fm.type) : 'note'
    return {
      id,
      vault: this.id,
      path: rel,
      type,
      title,
      aliases: toList(fm.aliases),
      tags: toList(fm.tags),
      campaign: type === 'campaign' ? title : stripLink(fm.campaign),
      visibility: fm.visibility ? String(fm.visibility) : null,
      frontmatter: fm,
      body: parsed.body,
      raw,
      version: versionOf(raw),
      created: isoOf(fm.created),
      updated: isoOf(fm.updated),
    }
  }

  /** Name → Notiz-ID (Titel vor Dateiname vor Pfad vor Alias). */
  resolveName(name: string, opts: { type?: string; campaign?: string | null } = {}): string | null {
    const n = norm(name.replace(/\.md$/i, ''))
    const rows = this.db.all<{ note_id: string; kind: string; type: string; campaign: string | null }>(
      `SELECT n.note_id, n.kind, t.type, t.campaign FROM names n JOIN notes t ON t.vault = n.vault AND t.id = n.note_id
       WHERE n.vault = ? AND n.norm = ?
       ORDER BY CASE n.kind WHEN 'title' THEN 0 WHEN 'file' THEN 1 WHEN 'path' THEN 2 ELSE 3 END`,
      this.id,
      n,
    )
    // Einträge ohne Kampagne passen zu jeder Kampagne
    const filtered = rows.filter((r) => (!opts.type || r.type === opts.type) && (opts.campaign === undefined || !opts.campaign || !r.campaign || norm(r.campaign) === norm(opts.campaign)))
    return (filtered[0] ?? (opts.type || opts.campaign ? undefined : rows[0]))?.note_id ?? null
  }

  backlinks(id: string) {
    const names = this.db.all<{ norm: string }>('SELECT norm FROM names WHERE vault = ? AND note_id = ?', this.id, id).map((r) => r.norm)
    if (!names.length) return []
    const rows = this.db.all<any>(
      `SELECT l.source_id, l.target, l.heading, l.display, l.embed, l.line, l.context, l.target_norm, l.dm, n.title, n.type, n.path, n.visibility
       FROM links l JOIN notes n ON n.vault = l.vault AND n.id = l.source_id
       WHERE l.vault = ? AND l.target_norm IN (${names.map(() => '?').join(',')}) AND l.source_id != ?
       ORDER BY n.updated DESC`,
      this.id,
      ...names,
      id,
    )
    const resolved = new Map<string, string | null>()
    return rows
      .filter((r) => {
        if (!resolved.has(r.target_norm)) resolved.set(r.target_norm, this.resolveName(r.target))
        return resolved.get(r.target_norm) === id
      })
      .map((r) => ({
        source_id: r.source_id,
        source_title: r.title,
        source_type: r.type,
        source_path: r.path,
        source_visibility: r.visibility,
        in_dm_block: !!r.dm,
        text: r.display ?? r.target,
        heading: r.heading,
        embed: !!r.embed,
        line: r.line,
        context: r.context,
      }))
  }

  outgoing(id: string) {
    const rows = this.db.all<any>('SELECT target, heading, display, embed, line, dm FROM links WHERE vault = ? AND source_id = ?', this.id, id)
    return rows.map((r) => {
      const target_id = this.resolveName(r.target)
      const t = target_id ? this.db.get<any>('SELECT title, type FROM notes WHERE vault = ? AND id = ?', this.id, target_id) : null
      const attachment = !target_id && /\.[a-z0-9]{2,5}$/i.test(r.target) && !/\.md$/i.test(r.target) && !!this.attachmentFile(r.target)
      return {
        target_id,
        text: r.display ?? r.target,
        target: r.target,
        heading: r.heading,
        embed: !!r.embed,
        line: r.line,
        resolved: !!target_id || attachment,
        attachment,
        target_title: t?.title ?? null,
        target_type: attachment ? 'attachment' : (t?.type ?? null),
        in_dm_block: !!r.dm,
      }
    })
  }

  backlinkCount(id: string): number {
    return this.backlinks(id).length
  }

  // ------------------------------------------------------------ Schreiben

  folderFor(type: string, campaign: string | null | undefined, title: string, when: Date = new Date()): string {
    const t = this.typeDef(type)
    let folder = t.folder ?? ''
    folder = folder.replace(/\{title\}/g, safeFileName(title))
    folder = folder.replace(/\{year\}/g, String(when.getFullYear())).replace(/\{month\}/g, String(when.getMonth() + 1).padStart(2, '0'))
    if (campaign) folder = folder.replace(/\{campaign\}/g, safeFileName(campaign))
    else folder = folder.replace(/\{campaign\}\/?/g, '')
    return folder.replace(/\/+$/, '').replace(/^\/+/, '')
  }

  templateBody(template: string | undefined, vars: Record<string, string>): string {
    if (!template) return `# ${vars.title}\n\n`
    const file = path.join(this.dir, '.basalt', 'templates', `${template}.md`)
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : (TEMPLATES[template] ?? `# {{title}}\n\n`)
    return text.replace(/\{\{(\w+)\}\}/g, (_m, k) => vars[k] ?? '')
  }

  listTemplates(): string[] {
    const dir = path.join(this.dir, '.basalt', 'templates')
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''))
  }

  private uniquePath(folder: string, title: string, exceptRel?: string): string {
    const base = safeFileName(title)
    let rel = folder ? `${folder}/${base}.md` : `${base}.md`
    let i = 2
    while (fs.existsSync(this.abs(rel)) && rel !== exceptRel) {
      rel = folder ? `${folder}/${base} ${i}.md` : `${base} ${i}.md`
      i++
    }
    return rel
  }

  async createNote(input: CreateNoteInput, wo: WriteOptions = {}): Promise<Note> {
    const title = (input.title ?? '').trim()
    if (!title) throw invalid('Titel fehlt.')
    const type = input.type || 'note'
    const fmIn = { ...(input.frontmatter ?? {}) }
    const campaign = stripLink(fmIn.campaign)
    const td = this.typeDef(type)
    const note = await this.mutex.run(() => {
      const id = input.id ?? ulid()
      const now = nowIso()
      const folder = input.folder !== undefined && input.folder !== null ? input.folder.replace(/^\/+|\/+$/g, '') : this.folderFor(type, campaign, title)
      const rel = this.uniquePath(folder, title)
      const fm: Record<string, any> = { id, type, title }
      for (const [k, v] of Object.entries(fmIn)) if (!['id', 'type', 'title'].includes(k) && v !== undefined) fm[k] = v
      for (const [k, v] of Object.entries(td.defaults ?? {})) if (fm[k] === undefined) fm[k] = v
      fm.created = fmIn.created ?? now
      fm.updated = now
      const body =
        input.body !== undefined && input.body !== null
          ? input.body
          : this.templateBody(input.template ?? td.template, { title, date: now.slice(0, 10), campaign: campaign ?? '', type })
      const raw = composeNote(stringifyFrontmatter(fm), body)
      this.writeRaw(rel, raw)
      this.upsertIndex(rel, id, raw, parseNote(raw), Date.now())
      return this.buildNote(id, rel, raw)
    })
    if (!wo.silent) {
      this.events.emit('note.created', this.id, { note_id: note.id, title: note.title, type: note.type, path: note.path })
      this.scheduleCommit(wo.commitMessage ?? `Neu: ${note.title}`)
    }
    return note
  }

  private checkVersion(note: Note, ifMatch: string | undefined | null) {
    if (ifMatch === undefined || ifMatch === null) return
    const v = ifMatch.replace(/^W\//, '').replace(/^"|"$/g, '')
    if (v === '*') return
    if (v !== note.version) {
      throw new ApiError('version_conflict', 'Die Notiz wurde inzwischen geändert.', {
        current_version: note.version,
        current: { body: note.body, frontmatter: note.frontmatter, raw: note.raw },
      })
    }
  }

  /** Low-Level: neuen Rohinhalt schreiben, indizieren, Ereignis + Commit planen. */
  private writeNoteUnlocked(note: Note, raw: string, wo: WriteOptions): Note {
    const rel = note.path
    this.writeRaw(rel, raw)
    this.upsertIndex(rel, note.id, raw, parseNote(raw), Date.now())
    return this.buildNote(note.id, rel, raw)
  }

  private afterWrite(note: Note, wo: WriteOptions, event: 'note.updated' = 'note.updated') {
    if (wo.silent) return
    this.events.emit(event, this.id, { note_id: note.id, title: note.title, type: note.type, path: note.path, version: note.version })
    this.scheduleCommit(wo.commitMessage ?? `Bearbeitet: ${note.title}`)
  }

  /** Komplett ersetzen (PUT). `raw` ODER `frontmatter`+`body`. */
  async replaceNote(id: string, input: { raw?: string; frontmatter?: Record<string, any>; body?: string }, ifMatch: string | undefined, wo: WriteOptions = {}): Promise<Note> {
    if (ifMatch === undefined && !wo.silent) throw new ApiError('validation_error', 'If-Match-Header fehlt.', { header: 'If-Match' })
    const note = await this.mutex.run(() => {
      const cur = this.getNote(id)
      this.checkVersion(cur, ifMatch)
      let raw: string
      if (input.raw !== undefined) {
        const p = parseNote(input.raw)
        const changes: Record<string, any> = { id }
        if (wo.touchUpdated !== false) changes.updated = nowIso()
        raw = composeNote(mergeFrontmatterText(p.fmText, changes), p.body)
      } else {
        const fm = { ...(input.frontmatter ?? cur.frontmatter) }
        fm.id = id
        if (!fm.type) fm.type = cur.type
        if (!fm.title) fm.title = cur.title
        if (!fm.created) fm.created = cur.frontmatter.created ?? nowIso()
        if (wo.touchUpdated !== false) fm.updated = nowIso()
        // Reihenfolge des bestehenden YAML so weit möglich erhalten
        const p = parseNote(cur.raw)
        const removed = Object.keys(cur.frontmatter).filter((k) => !(k in fm))
        raw = composeNote(mergeFrontmatterText(p.fmText, fm, removed), input.body ?? cur.body)
      }
      return this.writeNoteUnlocked(cur, raw, wo)
    })
    this.afterWrite(note, wo)
    return note
  }

  /** Teiländerung: Frontmatter zusammenführen, Text anhängen (am Ende oder unter Überschrift). */
  async patchNote(
    id: string,
    input: { frontmatter?: Record<string, any>; remove?: string[]; append?: string | { text: string; heading?: string } },
    ifMatch: string | undefined,
    wo: WriteOptions = {},
  ): Promise<Note> {
    const note = await this.mutex.run(() => {
      const cur = this.getNote(id)
      this.checkVersion(cur, ifMatch)
      const p = parseNote(cur.raw)
      const changes = { ...(input.frontmatter ?? {}) }
      delete changes.id
      if (wo.touchUpdated !== false) changes.updated = nowIso()
      const fmText = mergeFrontmatterText(p.fmText, changes, input.remove ?? [])
      let body = p.body
      if (input.append) {
        const a = typeof input.append === 'string' ? { text: input.append } : input.append
        body = appendText(body, a.text, a.heading)
      }
      return this.writeNoteUnlocked(cur, composeNote(fmText, body), wo)
    })
    this.afterWrite(note, wo)
    return note
  }

  /** In den Papierkorb (.trash/) verschieben. */
  async deleteNote(id: string, wo: WriteOptions = {}): Promise<{ id: string; trash_path: string }> {
    const result = await this.mutex.run(() => {
      const cur = this.getNote(id)
      let trashRel = `.trash/${cur.path}`
      let i = 2
      while (fs.existsSync(this.abs(trashRel))) trashRel = `.trash/${cur.path.replace(/\.md$/i, '')} ${i++}.md`
      fs.mkdirSync(path.dirname(this.abs(trashRel)), { recursive: true })
      this.ownWrites.set(cur.path, 'deleted')
      fs.renameSync(this.abs(cur.path), this.abs(trashRel))
      this.removeFromIndex(id)
      return { id, title: cur.title, path: cur.path, trash_path: trashRel }
    })
    if (!wo.silent) {
      this.events.emit('note.deleted', this.id, { note_id: id, title: result.title, path: result.path })
      this.scheduleCommit(wo.commitMessage ?? `Gelöscht: ${result.title}`)
    }
    return { id: result.id, trash_path: result.trash_path }
  }

  listTrash(): { path: string; title: string; deleted: string }[] {
    const dir = path.join(this.dir, '.trash')
    if (!fs.existsSync(dir)) return []
    const out: { path: string; title: string; deleted: string }[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name)
        if (e.isDirectory()) walk(full)
        else if (e.name.endsWith('.md')) {
          const rel = toPosix(path.relative(dir, full))
          out.push({ path: rel, title: e.name.replace(/\.md$/, ''), deleted: fs.statSync(full).mtime.toISOString() })
        }
      }
    }
    walk(dir)
    return out.sort((a, b) => b.deleted.localeCompare(a.deleted))
  }

  async restoreFromTrash(trashRel: string): Promise<Note> {
    const id = await this.mutex.run(() => {
      const src = safeJoin(path.join(this.dir, '.trash'), trashRel)
      if (!fs.existsSync(src)) throw notFound('Papierkorb-Eintrag')
      const folder = path.posix.dirname(trashRel) === '.' ? '' : path.posix.dirname(trashRel)
      const rel = this.uniquePath(folder, path.posix.basename(trashRel).replace(/\.md$/i, ''))
      fs.mkdirSync(path.dirname(this.abs(rel)), { recursive: true })
      fs.renameSync(src, this.abs(rel))
      return this.indexFileUnlocked(rel)
    })
    const note = this.getNote(id!)
    this.events.emit('note.created', this.id, { note_id: note.id, title: note.title, type: note.type, path: note.path })
    this.scheduleCommit(`Wiederhergestellt: ${note.title}`)
    return note
  }

  emptyTrash(): void {
    fs.rmSync(path.join(this.dir, '.trash'), { recursive: true, force: true })
  }

  /** Umbenennen/Verschieben: ID bleibt, Links im ganzen Vault werden angepasst. */
  async renameNote(id: string, input: { title?: string; folder?: string }, wo: WriteOptions = {}): Promise<{ note: Note; updated_links: number; updated_notes: string[] }> {
    const result = await this.mutex.run(() => {
      const cur = this.getNote(id)
      const newTitle = (input.title ?? cur.title).trim()
      if (!newTitle) throw invalid('Titel fehlt.')
      const oldFolder = path.posix.dirname(cur.path) === '.' ? '' : path.posix.dirname(cur.path)
      const folder = input.folder !== undefined ? input.folder.replace(/^\/+|\/+$/g, '') : oldFolder
      const oldNames = new Set(
        [cur.title, path.posix.basename(cur.path).replace(/\.md$/i, ''), cur.path.replace(/\.md$/i, '')].map((s) => norm(s)),
      )
      const newRel = newTitle === cur.title && folder === oldFolder ? cur.path : this.uniquePath(folder, newTitle, cur.path)
      // Backlinks vor dem Umbenennen ermitteln
      const sources = new Set(this.backlinks(id).map((b) => b.source_id))
      // Datei verschieben + Titel setzen
      const p = parseNote(cur.raw)
      const changes: Record<string, any> = { title: newTitle }
      if (wo.touchUpdated !== false) changes.updated = nowIso()
      let selfBody = p.body
      // Links in der eigenen Notiz auf sich selbst
      const selfRep = replaceLinks(selfBody, (t) => oldNames.has(norm(t)), newTitle)
      selfBody = selfRep.body
      const raw = composeNote(mergeFrontmatterText(p.fmText, changes), selfBody)
      if (newRel !== cur.path) {
        fs.mkdirSync(path.dirname(this.abs(newRel)), { recursive: true })
        this.ownWrites.set(cur.path, 'deleted')
        // Groß-/Kleinschreibung unter Windows: erst umbenennen, dann schreiben
        fs.renameSync(this.abs(cur.path), this.abs(newRel))
      }
      this.writeRaw(newRel, raw)
      this.removeFromIndex(id)
      this.upsertIndex(newRel, id, raw, parseNote(raw), Date.now())
      // Links in anderen Notizen anpassen
      let count = selfRep.count
      const updatedNotes: string[] = []
      for (const sid of sources) {
        const src = this.readNote(sid)
        if (!src) continue
        const sp = parseNote(src.raw)
        const rep = replaceLinks(sp.body, (t) => oldNames.has(norm(t)), newTitle)
        // Links in Eigenschaften
        let fmText = sp.fmText
        let fmCount = 0
        if (fmText !== null) {
          const fmRep = replaceLinks(fmText, (t) => oldNames.has(norm(t)), newTitle)
          fmText = fmRep.body
          fmCount = fmRep.count
        }
        if (rep.count + fmCount === 0) continue
        const sraw = composeNote(fmText, rep.body)
        this.writeRaw(src.path, sraw)
        this.upsertIndex(src.path, sid, sraw, parseNote(sraw), Date.now())
        count += rep.count + fmCount
        updatedNotes.push(sid)
      }
      return { note: this.buildNote(id, newRel, raw), oldPath: cur.path, oldTitle: cur.title, updated_links: count, updated_notes: updatedNotes }
    })
    if (!wo.silent) {
      this.events.emit('note.renamed', this.id, {
        note_id: id,
        title: result.note.title,
        old_title: result.oldTitle,
        path: result.note.path,
        old_path: result.oldPath,
        updated_notes: result.updated_notes,
      })
      this.scheduleCommit(wo.commitMessage ?? `Umbenannt: ${result.oldTitle} → ${result.note.title}`)
    }
    return { note: result.note, updated_links: result.updated_links, updated_notes: result.updated_notes }
  }

  /** Links auf eine Notiz auf ein anderes Ziel umbiegen (z. B. beim Zusammenführen). */
  async retargetLinks(fromId: string, toTitle: string, wo: WriteOptions = {}): Promise<number> {
    return this.mutex.run(() => {
      const cur = this.getNote(fromId)
      const oldNames = new Set([cur.title, path.posix.basename(cur.path).replace(/\.md$/i, ''), cur.path.replace(/\.md$/i, ''), ...cur.aliases].map((s) => norm(s)))
      let count = 0
      for (const b of new Set(this.backlinks(fromId).map((x) => x.source_id))) {
        const src = this.readNote(b)
        if (!src) continue
        const sp = parseNote(src.raw)
        const rep = replaceLinks(sp.body, (t) => oldNames.has(norm(t)), toTitle)
        if (!rep.count) continue
        const sraw = composeNote(sp.fmText, rep.body)
        this.writeRaw(src.path, sraw)
        this.upsertIndex(src.path, b, sraw, parseNote(sraw), Date.now())
        count += rep.count
      }
      void wo
      return count
    })
  }

  // ------------------------------------------------------------ Verwaltete Bereiche

  async putBlock(id: string, input: BlockInput, wo: WriteOptions = {}): Promise<Note> {
    if (!input.key) throw invalid('key fehlt.')
    const note = await this.mutex.run(() => {
      const cur = this.getNote(id)
      const p = parseNote(cur.raw)
      const body = setBlock(p.body, { ...input, updated: input.updated ?? nowIso().slice(0, 16) })
      if (body === p.body) return cur
      return this.writeNoteUnlocked(cur, composeNote(p.fmText, body), wo)
    })
    this.afterWrite(note, { ...wo, commitMessage: wo.commitMessage ?? `Bereich ${input.key}: ${note.title}` })
    return note
  }

  async deleteBlock(id: string, key: string, wo: WriteOptions = {}): Promise<boolean> {
    const res = await this.mutex.run(() => {
      const cur = this.getNote(id)
      const p = parseNote(cur.raw)
      const r = removeBlock(p.body, key)
      if (!r.removed) return null
      return this.writeNoteUnlocked(cur, composeNote(p.fmText, r.body), wo)
    })
    if (res) this.afterWrite(res, { ...wo, commitMessage: wo.commitMessage ?? `Bereich entfernt ${key}: ${res.title}` })
    return !!res
  }

  /** Alle Bereiche mit `key` (bzw. Präfix `key:`) entfernen, außer in `keep` (note_id → keys). */
  async deleteBlocksByKey(key: string, opts: { prefix?: boolean; keep?: Set<string> } = {}, wo: WriteOptions = {}): Promise<{ note_id: string; key: string }[]> {
    const rows = this.db.all<{ note_id: string; key: string }>(
      opts.prefix ? 'SELECT note_id, key FROM blocks WHERE vault = ? AND (key = ? OR key LIKE ?)' : 'SELECT note_id, key FROM blocks WHERE vault = ? AND key = ? AND ? IS NOT NULL',
      this.id,
      key,
      opts.prefix ? `${key}:%` : '',
    )
    const removed: { note_id: string; key: string }[] = []
    for (const r of rows) {
      if (opts.keep?.has(`${r.note_id}|${r.key}`)) continue
      if (await this.deleteBlock(r.note_id, r.key, wo)) removed.push(r)
    }
    return removed
  }

  // ------------------------------------------------------------ Verlauf

  async history(id: string) {
    const n = this.getNote(id)
    return this.git.log(n.path)
  }

  async historyRev(id: string, rev: string): Promise<string | null> {
    const n = this.getNote(id)
    return this.git.show(rev, n.path)
  }

  async restore(id: string, rev: string): Promise<Note> {
    const old = await this.historyRev(id, rev)
    if (old === null) throw notFound('Version')
    await this.flushCommit()
    const cur = this.getNote(id)
    const p = parseNote(old)
    const raw = composeNote(mergeFrontmatterText(p.fmText, { id, updated: nowIso() }), p.body)
    const note = await this.replaceNote(id, { raw }, cur.version, { commitMessage: `Wiederhergestellt: ${cur.title} (${rev.slice(0, 8)})`, touchUpdated: false })
    await this.flushCommit()
    return note
  }

  scheduleCommit(message: string) {
    this.pendingMessages.push(message)
    if (this.commitTimer) clearTimeout(this.commitTimer)
    this.commitTimer = setTimeout(() => void this.flushCommit(), this.opts.commitDelayMs)
  }

  async flushCommit(extraMessage?: string): Promise<string | null> {
    if (this.commitTimer) clearTimeout(this.commitTimer)
    this.commitTimer = null
    const msgs = [...new Set(this.pendingMessages)]
    this.pendingMessages = []
    if (extraMessage) msgs.unshift(extraMessage)
    if (!msgs.length) msgs.push('Änderungen')
    const subject = msgs.length === 1 ? msgs[0] : `${msgs[0]} (+${msgs.length - 1} weitere)`
    const body = msgs.length > 1 ? `\n\n${msgs.map((m) => `- ${m}`).join('\n')}` : ''
    try {
      return await this.git.commitAll(subject + body)
    } catch (e) {
      console.error(`[${this.id}] Commit fehlgeschlagen:`, (e as Error).message)
      return null
    }
  }

  // ------------------------------------------------------------ Ordner & Anhänge

  createFolder(rel: string) {
    const clean = rel.replace(/^\/+|\/+$/g, '')
    if (!clean || clean.split('/').some((p) => p.startsWith('.') || p === '..')) throw invalid('Ungültiger Ordnername.')
    fs.mkdirSync(this.abs(clean), { recursive: true })
  }

  async renameFolder(from: string, to: string): Promise<number> {
    const src = from.replace(/^\/+|\/+$/g, '')
    const dst = to.replace(/^\/+|\/+$/g, '')
    if (!src || !dst || dst.split('/').some((p) => p.startsWith('.') || p === '..')) throw invalid('Ungültiger Ordnername.')
    if (!fs.existsSync(this.abs(src))) throw notFound('Ordner')
    if (fs.existsSync(this.abs(dst))) throw new ApiError('conflict', 'Zielordner existiert bereits.')
    const files = this.listFiles(src)
    for (const f of files) this.ownWrites.set(f, 'deleted')
    fs.mkdirSync(path.dirname(this.abs(dst)), { recursive: true })
    fs.renameSync(this.abs(src), this.abs(dst))
    await this.mutex.run(() => {
      for (const f of files) this.removeFromIndexByPath(f)
      for (const f of this.listFiles(dst)) this.indexFileUnlocked(f)
    })
    this.scheduleCommit(`Ordner umbenannt: ${src} → ${dst}`)
    return files.length
  }

  async deleteFolder(rel: string): Promise<number> {
    const clean = rel.replace(/^\/+|\/+$/g, '')
    if (!clean) throw invalid('Ungültiger Ordner.')
    const files = this.listFiles(clean)
    for (const f of files) {
      const id = this.idOfPath(f)
      if (id) await this.deleteNote(id, { commitMessage: `Ordner gelöscht: ${clean}` })
    }
    fs.rmSync(this.abs(clean), { recursive: true, force: true })
    return files.length
  }

  saveAttachment(name: string, data: Buffer): string {
    const clean = safeFileName(path.basename(name)).replace(/\s+/g, '-')
    const ext = path.extname(clean)
    const base = clean.slice(0, clean.length - ext.length) || 'datei'
    let rel = `_attachments/${base}${ext}`
    let i = 2
    while (fs.existsSync(this.abs(rel))) rel = `_attachments/${base}-${i++}${ext}`
    writeFileAtomic(this.abs(rel), data)
    this.scheduleCommit(`Anhang: ${path.basename(rel)}`)
    return rel
  }

  attachmentFile(name: string): string | null {
    const candidates = [name, `_attachments/${name}`]
    for (const c of candidates) {
      try {
        const f = this.abs(c)
        if (fs.existsSync(f) && fs.statSync(f).isFile() && !c.split('/').some((p) => p.startsWith('.'))) return f
      } catch {
        // ungültiger Pfad
      }
    }
    return null
  }

  // ------------------------------------------------------------ Hilfen für Darstellung/Kurator

  summaryOf(id: string, max = 300): string {
    const row = this.db.get<{ body: string; frontmatter: string }>('SELECT body, frontmatter FROM notes WHERE vault = ? AND id = ?', this.id, id)
    if (!row) return ''
    const fm = json<Record<string, any>>(row.frontmatter, {})
    const props = Object.entries(fm)
      .filter(([k, v]) => !RESERVED_FM.has(k) && !['campaign', 'visibility', 'tags', 'source'].includes(k) && v !== null && typeof v !== 'object')
      .map(([k, v]) => `${k}: ${v}`)
      .join('; ')
    const text = row.body
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^#.*$/gm, '')
      .replace(/\s+/g, ' ')
      .trim()
    return `${props ? props + ' – ' : ''}${text}`.slice(0, max)
  }

  sectionHeadings(id: string): string[] {
    const n = this.readNote(id)
    return n ? headings(n.body).map((h) => h.text) : []
  }
}

/** Text ans Ende oder unter eine Überschrift anhängen (fügt nur ein). */
export function appendText(body: string, text: string, heading?: string): string {
  const t = text.replace(/\s+$/, '')
  if (heading) {
    const hs = headings(body)
    const idx = hs.findIndex((h) => h.text.toLowerCase() === heading.toLowerCase())
    if (idx >= 0) {
      const h = hs[idx]
      const next = hs.slice(idx + 1).find((x) => x.level <= h.level)
      let pos = next ? next.index : body.length
      while (pos > h.index && /\s/.test(body[pos - 1])) pos--
      const lineEnd = body.indexOf('\n', h.index)
      if (lineEnd >= 0 && pos < lineEnd) pos = lineEnd
      const tail = body.slice(pos)
      return body.slice(0, pos) + '\n' + t + (tail === '' ? '\n' : tail)
    }
    const prefix = body === '' ? '' : body.endsWith('\n\n') ? '' : body.endsWith('\n') ? '\n' : '\n\n'
    return `${body}${prefix}## ${heading}\n${t}\n`
  }
  const prefix = body === '' ? '' : body.endsWith('\n\n') ? '' : body.endsWith('\n') ? '\n' : '\n\n'
  return `${body}${prefix}${t}\n`
}
