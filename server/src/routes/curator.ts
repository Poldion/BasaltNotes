import type { FastifyInstance } from 'fastify'
import { json } from '../db.js'
import { invalid, notFound } from '../lib/errors.js'
import { clampLimit, decodeCursor, encodeCursor } from '../lib/util.js'
import { ApiError } from '../lib/errors.js'
import { Register, Services, T, vaultFor as baseVaultFor } from './common.js'

/** Eingang, Vorschläge und Läufe enthalten DM-Wissen – nicht für Spieler-Konten/-Tokens. */
const vaultFor: typeof baseVaultFor = (req, s, scope) => {
  if (req.principal?.visibility === 'players') throw new ApiError('forbidden', 'Für die Spieler-Sicht nicht verfügbar.')
  return baseVaultFor(req, s, scope)
}

const inboxSchema = {
  type: 'object',
  properties: {
    source: { type: 'object', properties: { app: { type: 'string' }, key: { type: 'string' }, url: { type: 'string' } } },
    note: {
      type: 'object',
      properties: { type: { type: 'string' }, title: { type: 'string' }, frontmatter: { type: 'object', additionalProperties: true }, body: { type: 'string' } },
    },
    text: { type: 'string' },
    campaign: { type: 'string' },
    attachments: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, kind: { type: 'string' }, markdown: { type: 'string' }, visibility: { type: 'string', enum: ['dm', 'players'] } },
        required: ['markdown'],
      },
    },
    curate: { type: 'string', enum: ['auto', 'review', 'none'] },
  },
}

export const registerCurator: Register = (app: FastifyInstance, s: Services) => {
  // ------------------------------------------------------------ Eingang

  app.post('/vaults/:vault/inbox', { schema: { tags: T.inbox, summary: 'Inhalt einliefern → 202 {inbox_id, status}', body: inboxSchema } }, async (req, reply) => {
    const v = vaultFor(req, s, 'inbox')
    const r = await s.inbox.submit(v.id, req.body as any)
    reply.code(202)
    return r
  })

  app.post(
    '/vaults/:vault/inbox/upload',
    { schema: { tags: T.inbox, summary: 'Dokument einliefern (multipart: file = PDF/DOCX/TXT/MD; optional title, type, campaign, curate, visibility) → 202' } },
    async (req, reply) => {
      const v = vaultFor(req, s, 'inbox')
      const fields: Record<string, string> = {}
      let file: { filename: string; data: Buffer } | null = null
      for await (const part of (req as any).parts()) {
        if (part.type === 'file') {
          if (file) throw invalid('Bitte nur eine Datei pro Upload.')
          file = { filename: part.filename || 'dokument', data: await part.toBuffer() }
        } else fields[part.fieldname] = String(part.value ?? '')
      }
      if (!file) throw invalid('Datei fehlt (multipart-Feld "file").')
      const curate = ['auto', 'review', 'none'].includes(fields.curate) ? (fields.curate as 'auto' | 'review' | 'none') : undefined
      const visibility = fields.visibility === 'players' ? 'players' : fields.visibility === 'dm' ? 'dm' : undefined
      const r = await s.inbox.submitDocument(v.id, {
        filename: file.filename,
        data: file.data,
        title: fields.title,
        type: fields.type,
        campaign: fields.campaign,
        curate,
        visibility,
      })
      reply.code(202)
      return r
    },
  )

  app.get('/vaults/:vault/inbox', { schema: { tags: T.inbox, summary: 'Eingang (?status=queued,running,processed,error,stored)' } }, async (req) => {
    const v = vaultFor(req, s, 'read')
    return s.inbox.list(v.id, req.query as any)
  })

  app.get('/vaults/:vault/inbox/:id', { schema: { tags: T.inbox, summary: 'Status, erzeugte Notiz, Lauf, Vorschläge' } }, async (req) => {
    const v = vaultFor(req, s, 'read')
    return s.inbox.get(v.id, (req.params as any).id)
  })

  app.post('/vaults/:vault/inbox/:id/reprocess', { schema: { tags: T.inbox, summary: 'Erneut verarbeiten (ersetzt alte Beiträge derselben Quelle)' } }, async (req, reply) => {
    const v = vaultFor(req, s, 'curate')
    const curate = (req.body as any)?.curate
    reply.code(202)
    return s.inbox.reprocess(v.id, (req.params as any).id, curate === 'review' ? 'review' : curate === 'auto' ? 'auto' : undefined)
  })

  app.post('/vaults/:vault/inbox/:id/cancel', { schema: { tags: T.inbox, summary: 'Verarbeitung dieses Eintrags abbrechen (wartend oder laufend)' } }, async (req) => {
    const v = vaultFor(req, s, 'curate')
    return s.inbox.cancel(v.id, (req.params as any).id)
  })

  app.get('/vaults/:vault/curator/status', { schema: { tags: T.curator, summary: 'Was der Kurator gerade tut: laufende Läufe mit Fortschritt, Anzahl wartender Aufträge' } }, async (req) => {
    const v = vaultFor(req, s, 'read')
    return s.inbox.status(v.id)
  })

  app.post(
    '/vaults/:vault/curator/duplicates',
    { schema: { tags: T.curator, summary: 'Duplikate suchen (ohne LLM) und Zusammenführ-Vorschläge anlegen (?dry_run=1 nur auflisten, ?min_score=0.85)' } },
    async (req) => {
      const v = vaultFor(req, s, 'curate')
      const q = req.query as any
      const min = Number(q.min_score)
      return s.curator.proposeDuplicates(v.id, { dryRun: q.dry_run === '1' || q.dry_run === 'true', minScore: min > 0 && min <= 1 ? min : undefined })
    },
  )

  app.post('/vaults/:vault/curator/stop', { schema: { tags: T.curator, summary: 'Kurator stoppen: laufenden Lauf abbrechen und Warteschlange leeren (vor dem Schreiben; nichts wird halb angewendet)' } }, async (req) => {
    const v = vaultFor(req, s, 'curate')
    return s.inbox.stopAll(v.id)
  })

  app.delete('/vaults/:vault/inbox/:id', { schema: { tags: T.inbox, summary: 'Eingangseintrag verwerfen' } }, async (req) => {
    const v = vaultFor(req, s, 'curate')
    return s.inbox.discard(v.id, (req.params as any).id)
  })

  // ------------------------------------------------------------ Vorschläge

  app.get('/vaults/:vault/proposals', { schema: { tags: T.curator, summary: 'Vorschläge (?status=open&campaign=…&run_id=…&diff=1)' } }, async (req) => {
    const v = vaultFor(req, s, 'read')
    const q = req.query as any
    const params: any[] = [v.id]
    let sql = 'SELECT * FROM proposals WHERE vault = ?'
    const status = q.status ?? 'open'
    if (status !== 'all') {
      sql += ' AND status = ?'
      params.push(status)
    }
    if (q.campaign) {
      sql += ' AND lower(campaign) = lower(?)'
      params.push(q.campaign)
    }
    if (q.run_id) {
      sql += ' AND run_id = ?'
      params.push(q.run_id)
    }
    const limit = clampLimit(q.limit, 100)
    const offset = decodeCursor(q.cursor)
    sql += ' ORDER BY created DESC LIMIT ? OFFSET ?'
    const rows = s.db.all<any>(sql, ...params, limit + 1, offset)
    const withDiff = q.diff === '1' || q.diff === 'true'
    return { items: rows.slice(0, limit).map((r) => s.curator.proposalJson(v, r, withDiff)), next_cursor: rows.length > limit ? encodeCursor(offset + limit) : null }
  })

  app.get('/vaults/:vault/proposals/:id', { schema: { tags: T.curator, summary: 'Vorschlag mit Diff (unified) und Begründung' } }, async (req) => {
    const v = vaultFor(req, s, 'read')
    return s.curator.proposalJson(v, s.curator.getProposal(v.id, (req.params as any).id), true)
  })

  app.patch('/vaults/:vault/proposals/:id', { schema: { tags: T.curator, summary: 'Vorschlag vor dem Annehmen anpassen (z. B. {to}, {title}, {alias}, {block: {content}})' } }, async (req) => {
    const v = vaultFor(req, s, 'curate')
    const row = s.curator.editProposal(v.id, (req.params as any).id, (req.body ?? {}) as any)
    return s.curator.proposalJson(v, row, true)
  })

  app.post('/vaults/:vault/proposals/:id/accept', { schema: { tags: T.curator, summary: 'Vorschlag annehmen' } }, async (req) => {
    const v = vaultFor(req, s, 'curate')
    return s.curator.resolveProposal(v.id, (req.params as any).id, 'accept')
  })

  app.post('/vaults/:vault/proposals/:id/reject', { schema: { tags: T.curator, summary: 'Vorschlag ablehnen' } }, async (req) => {
    const v = vaultFor(req, s, 'curate')
    return s.curator.resolveProposal(v.id, (req.params as any).id, 'reject')
  })

  app.post('/vaults/:vault/proposals/bulk', { schema: { tags: T.curator, summary: 'Gesammelt annehmen/ablehnen {ids, action: accept|reject}' } }, async (req) => {
    const v = vaultFor(req, s, 'curate')
    const b = (req.body ?? {}) as any
    if (!Array.isArray(b.ids) || !['accept', 'reject'].includes(b.action)) throw invalid('ids (Liste) und action (accept|reject) erforderlich.')
    const results = []
    for (const id of b.ids) {
      try {
        results.push(await s.curator.resolveProposal(v.id, String(id), b.action))
      } catch (e) {
        results.push({ id, error: (e as Error).message })
      }
    }
    return { results }
  })

  // ------------------------------------------------------------ Läufe

  app.get('/vaults/:vault/runs', { schema: { tags: T.curator, summary: 'Kurator-Läufe (Protokoll)' } }, async (req) => {
    const v = vaultFor(req, s, 'read')
    const q = req.query as any
    const limit = clampLimit(q.limit, 50)
    const offset = decodeCursor(q.cursor)
    const rows = s.db.all<any>(
      `SELECT r.id, r.source_key, r.inbox_id, r.note_id, r.campaign, r.mode, r.dry_run, r.status, r.commit_sha, r.error, r.llm, r.created, r.finished, r.reverted, r.applied,
              (SELECT COUNT(*) FROM proposals p WHERE p.run_id = r.id) AS proposals,
              (SELECT COUNT(*) FROM proposals p WHERE p.run_id = r.id AND p.status = 'open') AS open_proposals
       FROM runs r WHERE r.vault = ? ORDER BY r.created DESC LIMIT ? OFFSET ?`,
      v.id,
      limit + 1,
      offset,
    )
    return {
      items: rows.slice(0, limit).map((r) => {
        const applied = json<any[]>(r.applied, [])
        const note = r.note_id ? v.readNote(r.note_id) : null
        return {
          ...r,
          applied: undefined,
          dry_run: !!r.dry_run,
          llm: json(r.llm, null),
          note_title: note?.title ?? null,
          applied_count: applied.filter((a) => !a.error && !String(a.result ?? '').startsWith('übersprungen')).length,
          created_count: applied.filter((a) => a.result === 'angelegt').length,
        }
      }),
      next_cursor: rows.length > limit ? encodeCursor(offset + limit) : null,
    }
  })

  app.get('/vaults/:vault/runs/:id', { schema: { tags: T.curator, summary: 'Lauf mit Eingabe, Erkennung, Plan, angewendeten Operationen, Commit' } }, async (req) => {
    const v = vaultFor(req, s, 'read')
    const r = s.db.get<any>('SELECT * FROM runs WHERE vault = ? AND id = ?', v.id, (req.params as any).id)
    if (!r) throw notFound('Lauf')
    return {
      ...r,
      dry_run: !!r.dry_run,
      extraction: json(r.extraction, null),
      plan: json(r.plan, []),
      applied: json(r.applied, []),
      llm: json(r.llm, null),
      proposals: s.db.all<any>('SELECT id, kind, title, status, confidence FROM proposals WHERE run_id = ? ORDER BY created', r.id),
    }
  })

  app.post('/vaults/:vault/runs/:id/revert', { schema: { tags: T.curator, summary: 'Lauf rückgängig machen (git revert + Vorschläge verwerfen)' } }, async (req) => {
    const v = vaultFor(req, s, 'curate')
    return s.curator.revertRun(v.id, (req.params as any).id)
  })
}
