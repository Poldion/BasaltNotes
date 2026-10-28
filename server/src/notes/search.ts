import { Db, json } from '../db.js'
import { invalid } from '../lib/errors.js'
import { nameSimilarity } from '../lib/similarity.js'
import { clampLimit, decodeCursor, encodeCursor, norm } from '../lib/util.js'
import type { Vault } from './vault.js'

const COLUMNS: Record<string, string> = {
  id: 'n.id',
  type: 'n.type',
  title: 'n.title',
  campaign: 'n.campaign',
  path: 'n.path',
  visibility: 'n.visibility',
  created: 'n.created',
  updated: 'n.updated',
}

export interface WhereClause {
  field: string
  op: string
  value?: any
}

export interface NoteRow {
  id: string
  path: string
  type: string
  title: string
  campaign: string | null
  visibility: string | null
  frontmatter: string
  updated: string | null
  created: string | null
  version: string
}

export type Visibility = 'dm' | 'players' | undefined

/**
 * Was ein Zugang sehen darf: Sichtbarkeit (Spieler) und Bereich (Kampagne, Ordner, Typen).
 * Wird überall dort angewendet, wo Notizen aufgelistet, gesucht oder gelesen werden.
 */
export interface Restriction {
  visibility?: Visibility
  campaign?: string | null
  /** Bei Kampagne: auch Einträge ohne Kampagne */
  shared?: boolean
  folders?: string[]
  types?: string[]
}

/** Sichtbarkeit allein (alte Aufrufe) oder vollständige Einschränkung */
export type Access = Visibility | Restriction

export function toRestriction(a: Access | null | undefined): Restriction {
  return a && typeof a === 'object' ? a : { visibility: a ?? undefined }
}

export function isPlayers(a: Access | null | undefined): boolean {
  return toRestriction(a).visibility === 'players'
}

/** Hat die Einschränkung einen Bereich (nicht nur Sichtbarkeit)? */
export function hasArea(a: Access | null | undefined): boolean {
  const r = toRestriction(a)
  return !!r.campaign || !!r.folders?.length || !!r.types?.length
}

/** SQL-Bedingungen (Alias n) – Parameter werden in Reihenfolge an params angehängt */
export function restrictSql(a: Access | null | undefined, params: any[], alias = 'n'): string {
  const r = toRestriction(a)
  let sql = ''
  if (r.visibility === 'players') sql += ` AND ${alias}.visibility = 'players'`
  if (r.campaign) {
    sql += r.shared === false ? ` AND lower(${alias}.campaign) = lower(?)` : ` AND (${alias}.campaign IS NULL OR lower(${alias}.campaign) = lower(?))`
    params.push(r.campaign)
  }
  if (r.folders?.length) {
    sql += ` AND (${r.folders.map(() => `substr(${alias}.path, 1, length(?)) = ?`).join(' OR ')})`
    for (const f of r.folders) params.push(f + '/', f + '/')
  }
  if (r.types?.length) {
    sql += ` AND ${alias}.type IN (${r.types.map(() => '?').join(',')})`
    params.push(...r.types)
  }
  return sql
}

/** Darf der Zugang diese Notiz sehen? */
export function restrictionAllows(a: Access | null | undefined, note: { campaign?: string | null; path: string; type: string; visibility?: string | null }): boolean {
  const r = toRestriction(a)
  if (r.visibility === 'players' && note.visibility !== 'players') return false
  if (r.campaign) {
    if (note.campaign) {
      if (note.campaign.toLowerCase() !== r.campaign.toLowerCase()) return false
    } else if (r.shared === false) return false
  }
  if (r.folders?.length && !r.folders.some((f) => note.path.startsWith(f + '/'))) return false
  if (r.types?.length && !r.types.includes(note.type)) return false
  return true
}

/** FTS5-Abfrage aus freiem Text: jedes Wort als Präfix, alle müssen vorkommen. */
export function ftsQuery(q: string): string | null {
  const words = q
    .replace(/["*():^{}[\]]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w && !['AND', 'OR', 'NOT', 'NEAR'].includes(w.toUpperCase()))
  if (!words.length) return null
  return words.map((w) => `"${w.replace(/"/g, '')}"*`).join(' ')
}

export function rowToSummary(r: NoteRow, fields?: string[]) {
  const fm = json<Record<string, any>>(r.frontmatter, {})
  const base: Record<string, any> = {
    id: r.id,
    path: r.path,
    type: r.type,
    title: r.title,
    campaign: r.campaign,
    visibility: r.visibility,
    aliases: Array.isArray(fm.aliases) ? fm.aliases : fm.aliases ? [fm.aliases] : [],
    tags: Array.isArray(fm.tags) ? fm.tags : fm.tags ? [fm.tags] : [],
    created: r.created,
    updated: r.updated,
    version: r.version,
  }
  if (!fields || !fields.length) return { ...base, frontmatter: fm }
  const out: Record<string, any> = { id: r.id }
  for (const f of fields) {
    if (f === 'frontmatter') out.frontmatter = fm
    else if (f in base) out[f] = base[f]
    else out[f] = fm[f] ?? null
  }
  return out
}

export class Search {
  constructor(private db: Db) {}

  private propCond(field: string, op: string, value: any, params: any[]): string {
    const sub = (cmp: string) => `EXISTS (SELECT 1 FROM props p WHERE p.vault = n.vault AND p.note_id = n.id AND p.key = ? AND ${cmp})`
    if (field === 'tag' || field === 'tags') {
      const values = Array.isArray(value) ? value.map(String) : [String(value)]
      const cond = `EXISTS (SELECT 1 FROM tags t WHERE t.vault = n.vault AND t.note_id = n.id AND lower(t.tag) IN (${values.map(() => '?').join(',')}))`
      params.push(...values.map((v) => v.replace(/^#/, '').toLowerCase()))
      return op === '!=' || op === 'not_in' ? `NOT ${cond}` : cond
    }
    switch (op) {
      case '=':
      case '==':
        params.push(field, String(value))
        return sub('lower(p.value) = lower(?)')
      case '!=':
        params.push(field, String(value))
        return `NOT ${sub('lower(p.value) = lower(?)')}`
      case 'in':
      case 'not_in': {
        const values = (Array.isArray(value) ? value : [value]).map(String)
        if (!values.length) return op === 'in' ? '0' : '1'
        params.push(field, ...values.map((v) => v.toLowerCase()))
        const c = sub(`lower(p.value) IN (${values.map(() => '?').join(',')})`)
        return op === 'in' ? c : `NOT ${c}`
      }
      case 'contains':
        params.push(field, `%${String(value).toLowerCase()}%`)
        return sub('lower(p.value) LIKE ?')
      case 'exists':
        params.push(field)
        return sub("p.value IS NOT NULL AND p.value != ''")
      case 'not_exists':
        params.push(field)
        return `NOT ${sub("p.value IS NOT NULL AND p.value != ''")}`
      case '>':
      case '<':
      case '>=':
      case '<=': {
        params.push(field, value)
        const numeric = typeof value === 'number'
        return sub(numeric ? `CAST(p.value AS REAL) ${op} ?` : `p.value ${op} ?`)
      }
      default:
        throw invalid(`Unbekannter Operator: ${op}`)
    }
  }

  private colCond(col: string, op: string, value: any, params: any[]): string {
    switch (op) {
      case '=':
      case '==':
        params.push(String(value))
        return `lower(${col}) = lower(?)`
      case '!=':
        params.push(String(value))
        return `(${col} IS NULL OR lower(${col}) != lower(?))`
      case 'in':
      case 'not_in': {
        const values = (Array.isArray(value) ? value : [value]).map((v: any) => String(v).toLowerCase())
        if (!values.length) return op === 'in' ? '0' : '1'
        params.push(...values)
        const c = `lower(${col}) IN (${values.map(() => '?').join(',')})`
        return op === 'in' ? c : `NOT (${c})`
      }
      case 'contains':
        params.push(`%${String(value).toLowerCase()}%`)
        return `lower(${col}) LIKE ?`
      case 'exists':
        return `(${col} IS NOT NULL AND ${col} != '')`
      case 'not_exists':
        return `(${col} IS NULL OR ${col} = '')`
      case '>':
      case '<':
      case '>=':
      case '<=':
        params.push(value)
        return `${col} ${op} ?`
      default:
        throw invalid(`Unbekannter Operator: ${op}`)
    }
  }

  buildWhere(where: WhereClause[], params: any[]): string {
    return where
      .map((w) => {
        if (!w || !w.field) throw invalid('Feld fehlt in where.')
        const op = w.op ?? '='
        const col = COLUMNS[w.field]
        return col ? this.colCond(col, op, w.value, params) : this.propCond(w.field, op, w.value, params)
      })
      .map((c) => ` AND ${c}`)
      .join('')
  }

  private orderBy(sort: { field: string; dir?: string }[], params: any[]): string {
    if (!sort.length) return ' ORDER BY n.updated DESC'
    const parts = sort.map((s) => {
      const dir = (s.dir ?? 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC'
      const col = COLUMNS[s.field]
      if (col) return `${col} COLLATE NOCASE ${dir}`
      params.push(s.field)
      return `(SELECT p.value FROM props p WHERE p.vault = n.vault AND p.note_id = n.id AND p.key = ? LIMIT 1) ${dir}`
    })
    return ` ORDER BY ${parts.join(', ')}`
  }

  /** Strukturierte Abfrage (Dataview-ähnlich). */
  query(
    vault: string,
    body: { where?: WhereClause[]; sort?: { field: string; dir?: string }[]; select?: string[]; limit?: number; cursor?: string; q?: string },
    visibility?: Access,
  ) {
    const params: any[] = [vault]
    let sql = 'SELECT n.id, n.path, n.type, n.title, n.campaign, n.visibility, n.frontmatter, n.updated, n.created, n.version FROM notes n'
    if (body.q) {
      const fq = ftsQuery(body.q)
      if (fq) {
        sql += ' JOIN notes_fts ON notes_fts.id = n.id AND notes_fts.vault = n.vault'
      }
    }
    sql += ' WHERE n.vault = ?'
    if (body.q) {
      const fq = ftsQuery(body.q)
      if (fq) {
        sql += ' AND notes_fts MATCH ?'
        params.push(isPlayers(visibility) ? `{title aliases body_public}: ${fq}` : `{title aliases body}: ${fq}`)
      }
    }
    sql += this.buildWhere(body.where ?? [], params)
    sql += restrictSql(visibility, params)
    const countParams = [...params]
    const countSql = `SELECT COUNT(*) AS c FROM (${sql})`
    sql += this.orderBy(body.sort ?? [], params)
    const limit = clampLimit(body.limit)
    const offset = decodeCursor(body.cursor)
    sql += ' LIMIT ? OFFSET ?'
    params.push(limit + 1, offset)
    const rows = this.db.all<NoteRow>(sql, ...params)
    const total = this.db.get<{ c: number }>(countSql, ...countParams)?.c ?? 0
    const more = rows.length > limit
    return {
      items: rows.slice(0, limit).map((r) => rowToSummary(r, body.select)),
      total,
      next_cursor: more ? encodeCursor(offset + limit) : null,
    }
  }

  /** Liste mit einfachen Filtern (GET /notes). */
  list(vault: string, q: Record<string, any>, visibility?: Access) {
    const where: WhereClause[] = []
    if (q.type) where.push({ field: 'type', op: 'in', value: String(q.type).split(',') })
    if (q.tag) where.push({ field: 'tag', op: 'in', value: String(q.tag).split(',') })
    if (q.campaign) where.push({ field: 'campaign', op: '=', value: q.campaign })
    if (q.folder) where.push({ field: 'path', op: 'contains', value: `${q.folder}/` })
    if (q.due_from) where.push({ field: 'due', op: '>=', value: String(q.due_from) })
    if (q.due_to) where.push({ field: 'due', op: '<=', value: String(q.due_to) })
    if (q.updated_since) where.push({ field: 'updated', op: '>=', value: String(q.updated_since) })
    for (const [k, v] of Object.entries(q)) {
      if (k.startsWith('prop.')) where.push({ field: k.slice(5), op: '=', value: v })
    }
    const sort = q.sort
      ? String(q.sort)
          .split(',')
          .map((s) => (s.startsWith('-') ? { field: s.slice(1), dir: 'desc' } : { field: s, dir: 'asc' }))
      : [{ field: 'updated', dir: 'desc' }]
    const fields = q.fields ? String(q.fields).split(',') : undefined
    return this.query(vault, { where, sort, select: fields, limit: q.limit, cursor: q.cursor, q: q.q }, visibility)
  }

  /** Volltextsuche mit Treffer-Ausschnitten. */
  search(vault: string, q: string, filters: { type?: string; campaign?: string; tag?: string; limit?: any; cursor?: string; where?: WhereClause[] }, visibility?: Access) {
    const fq = ftsQuery(q ?? '')
    const players = isPlayers(visibility)
    const params: any[] = []
    let where = ''
    if (filters.type) where += this.buildWhere([{ field: 'type', op: 'in', value: String(filters.type).split(',') }], params)
    if (filters.campaign) where += this.buildWhere([{ field: 'campaign', op: '=', value: filters.campaign }], params)
    if (filters.tag) where += this.buildWhere([{ field: 'tag', op: 'in', value: String(filters.tag).split(',') }], params)
    if (filters.where) where += this.buildWhere(filters.where, params)
    where += restrictSql(visibility, params)
    const limit = clampLimit(filters.limit, 30, 200)
    const offset = decodeCursor(filters.cursor)
    if (!fq) {
      const where2 = [
        ...(filters.where ?? []),
        ...(filters.type ? [{ field: 'type', op: 'in', value: String(filters.type).split(',') }] : []),
        ...(filters.campaign ? [{ field: 'campaign', op: '=', value: filters.campaign }] : []),
        ...(filters.tag ? [{ field: 'tag', op: 'in', value: String(filters.tag).split(',') }] : []),
      ]
      const r = this.query(vault, { where: where2, limit, cursor: filters.cursor }, visibility)
      return { items: r.items.map((i) => ({ ...i, highlights: [] })), total: r.total, next_cursor: r.next_cursor }
    }
    const sql = `
      SELECT n.id, n.path, n.type, n.title, n.campaign, n.visibility, n.frontmatter, n.updated, n.created, n.version,
             snippet(notes_fts, ${players ? 5 : 4}, '<mark>', '</mark>', '…', 16) AS snip,
             highlight(notes_fts, 2, '<mark>', '</mark>') AS htitle,
             bm25(notes_fts, 0.0, 0.0, 10.0, 6.0, 1.0, 1.0) AS rank
      FROM notes_fts JOIN notes n ON n.vault = notes_fts.vault AND n.id = notes_fts.id
      WHERE notes_fts MATCH ? AND notes_fts.vault = ? ${where}
      ORDER BY rank LIMIT ? OFFSET ?`
    // Spieler-Sicht: nur im öffentlichen Text (ohne DM-Bereiche) suchen
    const match = players ? `{title aliases body_public}: ${fq}` : `{title aliases body}: ${fq}`
    const rows = this.db.all<NoteRow & { snip: string; htitle: string }>(sql, match, vault, ...params, limit + 1, offset)
    const more = rows.length > limit
    return {
      items: rows.slice(0, limit).map((r) => ({
        ...rowToSummary(r, ['title', 'type', 'path', 'campaign', 'updated', 'aliases', 'visibility']),
        highlights: [r.snip.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim()].filter(Boolean),
        title_highlight: r.htitle,
      })),
      next_cursor: more ? encodeCursor(offset + limit) : null,
    }
  }

  /** Alle Titel + Aliasse kompakt (z. B. Whisper-Glossar). */
  names(vault: string, opts: { campaign?: string; types?: string[]; visibility?: Access }) {
    const params: any[] = [vault]
    let sql = `SELECT n.id, n.title, n.type, n.campaign, n.frontmatter FROM notes n WHERE n.vault = ?`
    if (opts.campaign) {
      // Einträge ohne Kampagne gelten kampagnenübergreifend
      sql += ' AND (n.campaign IS NULL OR lower(n.campaign) = lower(?))'
      params.push(opts.campaign)
    }
    if (opts.types?.length) {
      sql += ` AND n.type IN (${opts.types.map(() => '?').join(',')})`
      params.push(...opts.types)
    }
    sql += restrictSql(opts.visibility, params)
    sql += ' ORDER BY n.type, n.title COLLATE NOCASE'
    const rows = this.db.all<any>(sql, ...params)
    const items = rows.map((r) => {
      const fm = json<Record<string, any>>(r.frontmatter, {})
      const aliases = Array.isArray(fm.aliases) ? fm.aliases.map(String) : fm.aliases ? [String(fm.aliases)] : []
      return { id: r.id, name: r.title, type: r.type, campaign: r.campaign, aliases }
    })
    const glossary = [...new Set(items.flatMap((i) => [i.name, ...i.aliases]))]
    return { items, glossary }
  }

  tags(vault: string) {
    return this.db.all<{ tag: string; count: number }>('SELECT tag, COUNT(*) AS count FROM tags WHERE vault = ? GROUP BY tag ORDER BY count DESC, tag', vault)
  }

  /** Kandidaten für einen Namen mit Score (exakt > ähnlich > Volltext). */
  resolve(v: Vault, name: string, opts: { type?: string; campaign?: string | null; limit?: number; access?: Access } = {}) {
    const n = norm(name)
    const params: any[] = [v.id]
    let sql = `SELECT nm.note_id, nm.display, nm.kind, t.title, t.type, t.campaign FROM names nm
               JOIN notes t ON t.vault = nm.vault AND t.id = nm.note_id WHERE nm.vault = ? AND nm.kind IN ('title','alias','file')`
    if (opts.type) {
      sql += ' AND t.type = ?'
      params.push(opts.type)
    }
    if (opts.campaign) {
      sql += ' AND (t.campaign IS NULL OR lower(t.campaign) = lower(?))'
      params.push(opts.campaign)
    }
    sql += restrictSql(opts.access, params, 't')
    const rows = this.db.all<any>(sql, ...params)
    const best = new Map<string, { id: string; title: string; type: string; campaign: string | null; score: number; matched: string; match: string }>()
    for (const r of rows) {
      const exact = norm(r.display) === n
      const score = exact ? 1 : nameSimilarity(name, r.display)
      const cur = best.get(r.note_id)
      if (!cur || score > cur.score)
        best.set(r.note_id, { id: r.note_id, title: r.title, type: r.type, campaign: r.campaign, score, matched: r.display, match: exact ? 'exact' : r.kind === 'alias' ? 'alias_similar' : 'similar' })
    }
    // Volltext als zusätzliche Quelle (z. B. Name nur im Text erwähnt)
    const fq = ftsQuery(name)
    if (fq) {
      const fts = this.db.all<any>(
        `SELECT n.id, n.title, n.type, n.campaign, n.path, n.visibility FROM notes_fts JOIN notes n ON n.vault = notes_fts.vault AND n.id = notes_fts.id
         WHERE notes_fts MATCH ? AND notes_fts.vault = ? ${opts.type ? 'AND n.type = ?' : ''} ORDER BY bm25(notes_fts, 0.0, 0.0, 10.0, 6.0, 1.0, 1.0) LIMIT 5`,
        `{title aliases}: ${fq}`,
        v.id,
        ...(opts.type ? [opts.type] : []),
      )
      for (const r of fts) {
        if (opts.campaign && r.campaign && norm(r.campaign) !== norm(opts.campaign)) continue
        if (!restrictionAllows(opts.access, r)) continue
        if (!best.has(r.id)) best.set(r.id, { id: r.id, title: r.title, type: r.type, campaign: r.campaign, score: 0.5, matched: r.title, match: 'fulltext' })
      }
    }
    return [...best.values()]
      .filter((c) => c.score >= 0.55)
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit ?? 5)
      .map((c) => ({ ...c, summary: v.summaryOf(c.id, 200) }))
  }

  graph(v: Vault, opts: { campaign?: string; types?: string[]; visibility?: Access }) {
    const params: any[] = [v.id]
    let sql = 'SELECT n.id, n.title, n.type, n.campaign FROM notes n WHERE n.vault = ?'
    if (opts.campaign) {
      sql += ' AND lower(n.campaign) = lower(?)'
      params.push(opts.campaign)
    }
    if (opts.types?.length) {
      sql += ` AND n.type IN (${opts.types.map(() => '?').join(',')})`
      params.push(...opts.types)
    }
    sql += restrictSql(opts.visibility, params)
    const nodes = this.db.all<any>(sql, ...params)
    const ids = new Set(nodes.map((n) => n.id))
    // Namensauflösung einmal vorab
    const names = this.db.all<{ norm: string; note_id: string; kind: string }>(
      `SELECT norm, note_id, kind FROM names WHERE vault = ? ORDER BY CASE kind WHEN 'title' THEN 0 WHEN 'file' THEN 1 WHEN 'path' THEN 2 ELSE 3 END`,
      v.id,
    )
    const map = new Map<string, string>()
    for (const n of names) if (!map.has(n.norm)) map.set(n.norm, n.note_id)
    const links = this.db.all<{ source_id: string; target_norm: string }>(
      `SELECT source_id, target_norm FROM links WHERE vault = ? ${isPlayers(opts.visibility) ? 'AND dm = 0' : ''}`,
      v.id,
    )
    const edgeSet = new Set<string>()
    const edges: { source: string; target: string }[] = []
    const degree = new Map<string, number>()
    for (const l of links) {
      const t = map.get(l.target_norm)
      if (!t || t === l.source_id || !ids.has(t) || !ids.has(l.source_id)) continue
      const key = `${l.source_id}>${t}`
      if (edgeSet.has(key)) continue
      edgeSet.add(key)
      edges.push({ source: l.source_id, target: t })
      degree.set(t, (degree.get(t) ?? 0) + 1)
      degree.set(l.source_id, (degree.get(l.source_id) ?? 0) + 1)
    }
    return { nodes: nodes.map((n) => ({ ...n, degree: degree.get(n.id) ?? 0 })), edges }
  }
}
