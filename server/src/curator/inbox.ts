import { profileOf } from '../notes/profiles.js'
import fs from 'node:fs'
import path from 'node:path'
import { ulid } from 'ulid'
import { Db, json, nowIso } from '../db.js'
import { EventBus } from '../events.js'
import { JobQueue } from '../jobs.js'
import { ApiError, invalid, isCancelled, notFound } from '../lib/errors.js'
import { clampLimit, decodeCursor, encodeCursor, renameRetry, sha256, slugify, writeFileAtomic } from '../lib/util.js'
import { removeBlock, stripBlockMarkers, stripDmBlocks } from '../notes/markdown.js'
import type { Note, Vault } from '../notes/vault.js'
import type { VaultManager } from '../notes/vaults.js'
import { Curator, curatorKeys } from './curator.js'
import { extractDocument } from './documents.js'

export interface InboxAttachment {
  name: string
  kind?: string
  markdown: string
  visibility?: 'dm' | 'players'
}

export interface InboxPayload {
  source?: { app?: string; key?: string; url?: string }
  note?: { type?: string; title?: string; frontmatter?: Record<string, any>; body?: string }
  /** Freitext ohne eigene Notiz (z. B. Schnellnotiz aus dem Panel) */
  text?: string
  campaign?: string
  attachments?: InboxAttachment[]
  curate?: 'auto' | 'review' | 'none'
  /** Hochgeladenes Dokument (PDF, Word, …), liegt als Anhang im Vault */
  document?: { name: string; kind: string; pages: number | null; size: number }
}

export interface DocumentUpload {
  filename: string
  data: Buffer
  title?: string
  type?: string
  campaign?: string
  curate?: 'auto' | 'review' | 'none'
  visibility?: 'dm' | 'players'
}

export class Inbox {
  constructor(
    private db: Db,
    private vaults: VaultManager,
    private curator: Curator,
    private jobs: JobQueue,
    private events: EventBus,
    /** Ist der KI-Kurator eingeschaltet? */
    private curatorOn: () => boolean = () => true,
  ) {
    jobs.register('curate_inbox', (p, job) => this.process(p.inbox_id, job.signal), 'llm')
    jobs.register(
      'curate_note',
      async (p, job) => {
        await this.curateNote(p.vault, p.note_id, { mode: p.mode, dryRun: false, signal: job.signal })
      },
      'llm',
    )
  }

  private findBySource(v: Vault, key: string): Note | null {
    const row = this.db.get<{ note_id: string }>("SELECT note_id FROM props WHERE vault = ? AND key = 'source' AND value = ?", v.id, key)
    return row ? v.readNote(row.note_id) : null
  }

  /** Kurator für diesen Vault aktiv? „Nur verknüpfen“ braucht keine KI und läuft auch bei ausgeschaltetem KI-Kurator. */
  private curates(v: Vault): boolean {
    return v.config.curator.enabled && (this.curatorOn() || v.config.curator.mode === 'link')
  }

  /** Einliefern: Notiz sofort anlegen/aktualisieren, Kurator im Hintergrund. */
  async submit(vaultId: string, payload: InboxPayload): Promise<{ inbox_id: string; status: string; note_id: string | null; note_path: string | null }> {
    const v = this.vaults.get(vaultId)
    // Kurator aus: Eingang nimmt weiter an und legt die Notiz ab, sortiert aber nichts ein
    const curate = this.curates(v) ? (payload.curate ?? 'auto') : 'none'
    if (!['auto', 'review', 'none'].includes(curate)) throw invalid('curate muss auto, review oder none sein.')
    if (!payload.note?.title && !payload.text?.trim()) throw invalid('note.title oder text ist erforderlich.')
    const inboxId = ulid()
    const sourceKey = payload.source?.key?.trim() || `inbox:${inboxId}`
    const now = nowIso()

    // Rohdaten im Eingangsordner ablegen
    writeFileAtomic(path.join(v.dir, '_inbox', `${inboxId}.json`), JSON.stringify({ received: now, ...payload }, null, 2))

    let note: Note | null = null
    let campaign = payload.campaign ?? payload.note?.frontmatter?.campaign ?? null
    const profile = profileOf(v)
    if (profile?.resolveGroup) campaign = await profile.resolveGroup({ v, db: this.db, slugify, name: campaign })

    if (payload.note?.title) {
      const n = payload.note
      const title = n.title!.trim()
      const type = n.type || (profile?.defaultInboxType ?? 'meeting')
      const fm: Record<string, any> = { ...(n.frontmatter ?? {}) }
      delete fm.id
      if (campaign) fm.campaign = campaign
      fm.source = sourceKey
      if (payload.source?.url) fm.source_url = payload.source.url
      note = this.findBySource(v, sourceKey)
      profile?.inboxFrontmatter?.({ v, db: this.db, slugify, type, group: campaign, frontmatter: fm, isNew: !note })
      if (note) {
        if (note.title !== title) note = (await v.renameNote(note.id, { title })).note
        note = await v.patchNote(note.id, { frontmatter: { ...fm, type } }, undefined)
      } else {
        const intro = payload.document ? `Originaldatei: ![[${payload.document.name}]]\n\n` : ''
        note = await v.createNote({ type, title, frontmatter: fm, body: `# ${title}\n\n${intro}` })
      }
      // Inhalt als verwaltete Bereiche: eigener Text in der Notiz bleibt unberührt
      if (n.body?.trim())
        note = await v.putBlock(note.id, { key: `${sourceKey}:recap`, heading: payload.document ? 'Inhalt' : null, content: n.body, source: null, visibility: null })
      const attKeys = new Set<string>()
      for (const a of payload.attachments ?? []) {
        if (!a?.markdown?.trim()) continue
        const key = `${sourceKey}:att:${slugify(a.kind || a.name || 'anhang')}`
        attKeys.add(key)
        note = await v.putBlock(note.id, { key, heading: a.name || a.kind || 'Anhang', content: a.markdown, source: null, visibility: a.visibility === 'dm' ? 'dm' : null })
      }
      // Anhänge, die es nicht mehr gibt, entfernen
      for (const b of this.db.all<{ key: string }>('SELECT key FROM blocks WHERE vault = ? AND note_id = ? AND key LIKE ?', v.id, note.id, `${sourceKey}:att:%`)) {
        if (!attKeys.has(b.key)) await v.deleteBlock(note.id, b.key)
      }
    }

    const status = curate === 'none' ? 'stored' : 'queued'
    this.db.run(
      'INSERT INTO inbox (id, vault, source_key, source, payload, curate, status, note_id, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?)',
      inboxId,
      v.id,
      sourceKey,
      JSON.stringify(payload.source ?? null),
      JSON.stringify({ ...payload, campaign }),
      curate,
      status,
      note?.id ?? null,
      now,
      now,
    )
    this.events.emit('inbox.queued', v.id, { inbox_id: inboxId, note_id: note?.id ?? null, source_key: sourceKey, curate })
    if (curate !== 'none') this.jobs.enqueue('curate_inbox', v.id, { inbox_id: inboxId }, { maxAttempts: 3 })
    else this.archive(v, inboxId)
    return { inbox_id: inboxId, status, note_id: note?.id ?? null, note_path: note?.path ?? null }
  }

  /**
   * Dokument (PDF, Word, Text) einliefern: Original als Anhang ablegen, Text auslesen, Notiz anlegen,
   * Kurator im Hintergrund. Gleiche Datei erneut hochladen → gleiche Notiz wird aktualisiert.
   */
  async submitDocument(vaultId: string, up: DocumentUpload) {
    const v = this.vaults.get(vaultId)
    const doc = await extractDocument(up.filename, up.data)
    const hash = sha256(up.data.toString('base64')).slice(0, 16)
    const sourceKey = `upload:${hash}`
    const existing = this.findBySource(v, sourceKey)
    const attachment = existing?.frontmatter.document ? String(existing.frontmatter.document) : path.posix.basename(v.saveAttachment(up.filename, up.data))
    const defaults = profileOf(v)?.documentDefaults?.({ v, visibility: up.visibility }) ?? {}
    const type = up.type && v.config.types[up.type] ? up.type : (defaults.type ?? 'note')
    const title = (up.title?.trim() || path.basename(up.filename).replace(/\.[^.]+$/, '')).trim() || 'Dokument'
    const visibility = defaults.visibility
    return this.submit(v.id, {
      source: { app: 'upload', key: sourceKey, url: `/api/v1/vaults/${encodeURIComponent(v.id)}/attachments/${encodeURIComponent(attachment)}` },
      note: { type, title, frontmatter: { ...(visibility ? { visibility } : {}), document: attachment, document_kind: doc.kind, ...(doc.pages ? { pages: doc.pages } : {}) }, body: doc.text },
      campaign: up.campaign || undefined,
      curate: up.curate ?? 'auto',
      document: { name: attachment, kind: doc.kind, pages: doc.pages, size: up.data.length },
    })
  }

  /** Text, den der Kurator für einen Eingangseintrag liest. */
  private inputText(v: Vault, payload: InboxPayload, note: Note | null): string {
    const parts: string[] = []
    if (payload.note?.body) parts.push(payload.note.body)
    for (const a of payload.attachments ?? []) if (a?.markdown) parts.push(`## ${a.name || a.kind}${a.visibility === 'dm' ? ' (nur DM)' : ''}\n${a.markdown}`)
    if (payload.text) parts.push(payload.text)
    if (!parts.length && note) parts.push(stripBlockMarkers(note.body))
    return parts.join('\n\n').trim()
  }

  async process(inboxId: string, signal?: AbortSignal) {
    const row = this.db.get<any>('SELECT * FROM inbox WHERE id = ?', inboxId)
    if (!row) return
    const v = this.vaults.get(row.vault)
    if (!this.curates(v)) {
      // Inzwischen ausgeschaltet: als „abgelegt“ markieren statt zu verarbeiten
      this.db.run("UPDATE inbox SET status = 'stored', updated = ? WHERE id = ?", nowIso(), inboxId)
      this.archive(v, inboxId)
      return
    }
    const payload = json<InboxPayload>(row.payload, {})
    this.db.run("UPDATE inbox SET status = 'running', updated = ? WHERE id = ?", nowIso(), inboxId)
    // Hochgeladene DM-Dokumente (z. B. Abenteuer-Skripte) verraten nichts an die Spieler-Sicht
    const dmOnly = !!payload.document && payload.note?.frontmatter?.visibility === 'dm'
    try {
      const note = row.note_id ? v.readNote(row.note_id) : null
      const result = await this.curator.run({
        vault: v.id,
        sourceKey: row.source_key,
        sourceNoteId: note?.id ?? null,
        sourceLabel: note ? undefined : `Schnellnotiz ${row.created.slice(0, 16).replace('T', ' ')}`,
        text: this.inputText(v, payload, note),
        playersText: dmOnly ? '' : this.inputText(v, { ...payload, attachments: (payload.attachments ?? []).filter((a) => a?.visibility !== 'dm') }, note),
        forceDm: dmOnly,
        campaign: payload.campaign ?? note?.campaign ?? null,
        mode: row.curate === 'review' ? 'review' : 'auto',
        inboxId,
      }, signal)
      const summary = { run_id: result.run_id, created: result.created, updated: result.updated, proposals: result.proposals }
      this.db.run("UPDATE inbox SET status = 'processed', run_id = ?, result = ?, error = NULL, updated = ? WHERE id = ?", result.run_id, JSON.stringify(summary), nowIso(), inboxId)
      this.archive(v, inboxId)
      this.events.emit('inbox.processed', v.id, { inbox_id: inboxId, note_id: row.note_id, ...summary })
    } catch (e) {
      if (isCancelled(e) || signal?.aborted) {
        this.db.run("UPDATE inbox SET status = 'cancelled', error = 'Vom Benutzer abgebrochen.', updated = ? WHERE id = ?", nowIso(), inboxId)
        this.events.emit('inbox.cancelled', v.id, { inbox_id: inboxId, note_id: row.note_id })
        throw e
      }
      const msg = (e as Error).message
      const llmDown = e instanceof ApiError && e.code === 'llm_unavailable' && !(e as any).noRetry
      this.db.run('UPDATE inbox SET status = ?, error = ?, updated = ? WHERE id = ?', llmDown ? 'queued' : 'error', msg, nowIso(), inboxId)
      if (!llmDown) {
        this.events.emit('inbox.failed', v.id, { inbox_id: inboxId, note_id: row.note_id, error: msg })
        if (e && typeof e === 'object') (e as any).noRetry = true
      } else {
        // Bei endgültigem Scheitern setzt der letzte Versuch den Status
        const job = this.db.get<any>("SELECT attempts, max_attempts FROM jobs WHERE kind = 'curate_inbox' AND payload LIKE ? ORDER BY created DESC LIMIT 1", `%${inboxId}%`)
        if (job && job.attempts >= job.max_attempts) {
          this.db.run("UPDATE inbox SET status = 'error', updated = ? WHERE id = ?", nowIso(), inboxId)
          this.events.emit('inbox.failed', v.id, { inbox_id: inboxId, note_id: row.note_id, error: msg })
        }
      }
      throw e
    }
  }

  private archive(v: Vault, inboxId: string) {
    const src = path.join(v.dir, '_inbox', `${inboxId}.json`)
    if (!fs.existsSync(src)) return
    const dst = path.join(v.dir, '_inbox', 'archiv', `${inboxId}.json`)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    // Archivieren ist Nebensache – darf nie einen Eingang scheitern lassen
    try {
      renameRetry(src, dst)
    } catch (e) {
      console.warn(`[${v.id}] Eingang ${inboxId} nicht archiviert: ${(e as Error).message}`)
    }
  }

  list(vaultId: string, q: { status?: string; limit?: any; cursor?: string }) {
    const limit = clampLimit(q.limit)
    const offset = decodeCursor(q.cursor)
    const params: any[] = [vaultId]
    let sql = 'SELECT * FROM inbox WHERE vault = ?'
    if (q.status) {
      const st = String(q.status).split(',')
      sql += ` AND status IN (${st.map(() => '?').join(',')})`
      params.push(...st)
    }
    sql += ' ORDER BY created DESC LIMIT ? OFFSET ?'
    const rows = this.db.all<any>(sql, ...params, limit + 1, offset)
    return { items: rows.slice(0, limit).map((r) => this.toJson(r, false)), next_cursor: rows.length > limit ? encodeCursor(offset + limit) : null }
  }

  get(vaultId: string, id: string) {
    const row = this.db.get<any>('SELECT * FROM inbox WHERE vault = ? AND id = ?', vaultId, id)
    if (!row) throw notFound('Eingangseintrag')
    const out: any = this.toJson(row, true)
    if (row.run_id) {
      const run = this.db.get<any>('SELECT id, status, created, finished, commit_sha, error FROM runs WHERE id = ?', row.run_id)
      out.run = run ?? null
      out.proposals = this.db.all<any>('SELECT id, kind, title, status, confidence FROM proposals WHERE run_id = ?', row.run_id)
    }
    return out
  }

  private toJson(r: any, full: boolean) {
    const payload = json<InboxPayload>(r.payload, {})
    return {
      id: r.id,
      vault: r.vault,
      status: r.status,
      curate: r.curate,
      source_key: r.source_key,
      source: json(r.source, null),
      title: payload.note?.title ?? (payload.text ? payload.text.slice(0, 80) : null),
      campaign: payload.campaign ?? null,
      note_id: r.note_id,
      run_id: r.run_id,
      result: json(r.result, null),
      error: r.error,
      created: r.created,
      updated: r.updated,
      ...(full ? { payload } : {}),
    }
  }

  reprocess(vaultId: string, id: string, curate?: 'auto' | 'review') {
    const row = this.db.get<any>('SELECT * FROM inbox WHERE vault = ? AND id = ?', vaultId, id)
    if (!row) throw notFound('Eingangseintrag')
    if (row.status === 'running') throw new ApiError('conflict', 'Wird gerade verarbeitet.')
    const mode = curate ?? (row.curate === 'none' ? 'auto' : row.curate)
    this.db.run("UPDATE inbox SET status = 'queued', curate = ?, error = NULL, updated = ? WHERE id = ?", mode, nowIso(), id)
    this.jobs.enqueue('curate_inbox', vaultId, { inbox_id: id }, { maxAttempts: 3 })
    this.events.emit('inbox.queued', vaultId, { inbox_id: id, note_id: row.note_id, source_key: row.source_key, curate: mode, reprocess: true })
    return { inbox_id: id, status: 'queued' }
  }

  /** Einen Eingangseintrag abbrechen (wartend oder laufend). */
  cancel(vaultId: string, id: string) {
    const row = this.db.get<any>('SELECT * FROM inbox WHERE vault = ? AND id = ?', vaultId, id)
    if (!row) throw notFound('Eingangseintrag')
    if (!['queued', 'running'].includes(row.status)) throw new ApiError('conflict', 'Der Eintrag wird gerade nicht verarbeitet.')
    let state: 'running' | 'queued' | null = null
    for (const j of this.jobs.pending(['curate_inbox'], vaultId)) if (j.payload.includes(id)) state = this.jobs.cancel(j.id) ?? state
    if (state !== 'running') {
      this.db.run("UPDATE inbox SET status = 'cancelled', error = 'Vom Benutzer abgebrochen.', updated = ? WHERE id = ?", nowIso(), id)
      this.events.emit('inbox.cancelled', vaultId, { inbox_id: id, note_id: row.note_id })
    }
    return { inbox_id: id, status: state === 'running' ? 'stopping' : 'cancelled' }
  }

  /** Kurator für einen Vault stoppen: laufenden Lauf abbrechen, Warteschlange leeren. */
  stopAll(vaultId: string) {
    let running = 0
    let queued = 0
    for (const j of this.jobs.pending(['curate_inbox', 'curate_note'], vaultId)) {
      const state = this.jobs.cancel(j.id)
      if (state === 'running') running++
      if (state === 'queued') {
        queued++
        const inboxId = j.kind === 'curate_inbox' ? (json<{ inbox_id?: string }>(j.payload, {}).inbox_id ?? null) : null
        if (inboxId) {
          this.db.run("UPDATE inbox SET status = 'cancelled', error = 'Vom Benutzer abgebrochen.', updated = ? WHERE id = ? AND status = 'queued'", nowIso(), inboxId)
          this.events.emit('inbox.cancelled', vaultId, { inbox_id: inboxId })
        }
      }
    }
    return { stopped_running: running, cancelled_queued: queued }
  }

  /** Was der Kurator gerade tut (für die Anzeige „Kurator arbeitet …“). */
  status(vaultId: string) {
    const running = [...this.curator.progress.values()].filter((p) => p.vault === vaultId)
    const pending = this.jobs.pending(['curate_inbox', 'curate_note'], vaultId)
    return { running, queued: pending.filter((j) => j.status === 'queued').length }
  }

  discard(vaultId: string, id: string) {
    const row = this.db.get<any>('SELECT * FROM inbox WHERE vault = ? AND id = ?', vaultId, id)
    if (!row) throw notFound('Eingangseintrag')
    this.db.run("UPDATE inbox SET status = 'discarded', updated = ? WHERE id = ?", nowIso(), id)
    this.db.run("UPDATE jobs SET status = 'done', error = 'verworfen' WHERE kind = 'curate_inbox' AND status = 'queued' AND payload LIKE ?", `%${id}%`)
    return { inbox_id: id, status: 'discarded' }
  }

  /** Bestehende Notiz durch den Kurator schicken. */
  async curateNote(vaultId: string, noteId: string, opts: { mode?: 'auto' | 'review'; dryRun?: boolean; signal?: AbortSignal }) {
    const v = this.vaults.get(vaultId)
    const note = v.getNote(noteId)
    const sourceKey = note.frontmatter.source ? String(note.frontmatter.source) : `note:${note.id}`
    // Kurator-eigene Bereiche nicht erneut einlesen
    let text = note.body
    for (const key of curatorKeys(sourceKey)) text = removeBlock(text, key).body
    return this.curator.run({
      vault: v.id,
      sourceKey,
      sourceNoteId: note.id,
      text: stripBlockMarkers(text).trim(),
      playersText: stripBlockMarkers(stripDmBlocks(text)).trim(),
      campaign: note.campaign,
      mode: opts.mode ?? 'auto',
      dryRun: opts.dryRun,
    }, opts.signal)
  }

  enqueueCurateNote(vaultId: string, noteId: string, mode: 'auto' | 'review') {
    const v = this.vaults.get(vaultId)
    v.getNote(noteId)
    return this.jobs.enqueue('curate_note', vaultId, { vault: vaultId, note_id: noteId, mode }, { maxAttempts: 2 })
  }

}
