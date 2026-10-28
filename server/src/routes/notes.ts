import fs from 'node:fs'
import path from 'node:path'
import { createTwoFilesPatch } from 'diff'
import type { FastifyInstance } from 'fastify'
import { ApiError, invalid, notFound } from '../lib/errors.js'
import { requireScope } from '../auth.js'
import { appendTask, composeNote, listTasks, parseNote, setTask, stripBlockMarkers, stripDmBlocks } from '../notes/markdown.js'
import { linkNoteBody } from '../curator/linker.js'
import { utcToLocal } from '../lib/time.js'
import { plainLinks } from '../chat/chat.js'
import type { Vault } from '../notes/vault.js'
import type { FastifyRequest } from 'fastify'
import { stripLink } from '../notes/vault.js'
import { restrictionAllows } from '../notes/search.js'
import { Register, Services, T, accessOf, assertInArea, isAreaRestricted, noteFor, noteJson, renderAccess, renderer, vaultFor, visibilityOf } from './common.js'

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
}

const noteBodySchema = {
  type: 'object',
  properties: {
    type: { type: 'string' },
    title: { type: 'string' },
    frontmatter: { type: 'object', additionalProperties: true },
    body: { type: 'string' },
    folder: { type: 'string' },
    template: { type: 'string' },
  },
  required: ['title'],
}

function ifMatch(headers: Record<string, any>): string | undefined {
  const h = headers['if-match']
  return typeof h === 'string' && h ? h : undefined
}

/** Markdown ohne Frontmatter, Bereichs-Markierungen und [[ ]] (für Dashboards) */
function cleanMarkdown(body: string): string {
  return plainLinks(stripBlockMarkers(body).replace(/<!--[\s\S]*?-->/g, '')).replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

/** ?clean=1: body bereinigt, ohne raw */
function cleanJson(q: any, out: Record<string, any>): Record<string, any> {
  if (q.clean !== '1' && q.clean !== 'true') return out
  const { raw: _raw, ...rest } = out
  return typeof rest.body === 'string' ? { ...rest, body: cleanMarkdown(rest.body) } : rest
}

/** Tagebuch-Eintrag eines Tages finden oder anlegen (Standard: heute in der eingestellten Zeitzone) */
async function journalFor(s: Services, req: FastifyRequest, v: Vault, dateIn?: string): Promise<{ note: ReturnType<Vault['getNote']>; created: boolean }> {
  if (!v.config.types.journal) throw invalid('Dieses Notizbuch hat keinen Typ „Tagebuch“ (journal).')
  const date = dateIn ?? utcToLocal(Date.now()).slice(0, 10)
  const hit = s.db.get<{ id: string }>(
    `SELECT n.id FROM notes n WHERE n.vault = ? AND n.type = 'journal' AND (n.title = ? OR EXISTS (SELECT 1 FROM props p WHERE p.vault = n.vault AND p.note_id = n.id AND p.key = 'date' AND substr(p.value, 1, 10) = ?)) ORDER BY n.created LIMIT 1`,
    v.id,
    date,
    date,
  )
  if (hit) return { note: noteFor(req, v, hit.id), created: false }
  const folder = v.folderFor('journal', null, date, new Date(`${date}T12:00:00`))
  if (isAreaRestricted(req, v.id)) assertInArea(req, v, { campaign: accessOf(req, v.id).campaign ?? null, type: 'journal', path: `${folder ? folder + '/' : ''}${date}.md` })
  const note = await v.createNote({ type: 'journal', title: date, frontmatter: { date }, folder })
  return { note, created: true }
}

export const registerNotes: Register = (app: FastifyInstance, s: Services) => {
  app.get('/vaults/:vault/notes', { schema: { tags: T.notes, summary: 'Notizen auflisten (Filter: type, tag, campaign, prop.<name>, q, updated_since, sort, fields, limit, cursor)' } }, async (req) => {
    const v = vaultFor(req, s, 'read')
    const q = { ...(req.query as any) }
    return s.search.list(v.id, q, accessOf(req, v.id))
  })

  app.get('/vaults/:vault/notes/by-path', { schema: { tags: T.notes, summary: 'Notiz über Pfad finden' } }, async (req) => {
    const v = vaultFor(req, s, 'read')
    const p = String((req.query as any).path ?? '').replace(/^\/+/, '')
    const id = v.idOfPath(p) ?? v.idOfPath(`${p}.md`)
    if (!id) throw notFound('Notiz')
    return noteJson(v, noteFor(req, v, id), { visibility: visibilityOf(req), access: accessOf(req, v.id) })
  })

  app.get('/vaults/:vault/notes/by-title', { schema: { tags: T.notes, summary: 'Notiz über Titel oder Alias finden' } }, async (req) => {
    const v = vaultFor(req, s, 'read')
    const q = req.query as any
    const access = accessOf(req, v.id)
    // Bei Bereichs-Einschränkung nur Treffer im Bereich (gleichnamige Notizen außerhalb bleiben unsichtbar)
    const id = isAreaRestricted(req, v.id)
      ? (s.search.resolve(v, String(q.title ?? ''), { type: q.type, campaign: q.campaign, access, limit: 1 }).find((c) => c.score === 1)?.id ?? null)
      : v.resolveName(String(q.title ?? ''), { type: q.type, campaign: q.campaign })
    if (!id) throw notFound('Notiz')
    return cleanJson(q, noteJson(v, noteFor(req, v, id), { visibility: visibilityOf(req), access, fields: q.fields ? String(q.fields).split(',') : undefined }))
  })

  app.get('/vaults/:vault/notes/:id', { schema: { tags: T.notes, summary: 'Notiz lesen (?format=json|markdown|html)' } }, async (req, reply) => {
    const v = vaultFor(req, s, 'read')
    const note = noteFor(req, v, (req.params as any).id)
    const q = req.query as any
    const vis = visibilityOf(req)
    reply.header('ETag', `"${note.version}"`)
    if (q.format === 'markdown') {
      reply.type('text/markdown; charset=utf-8')
      // ?clean=1: nur der Text – ohne Frontmatter, Bereichs-Markierungen und [[ ]] (z. B. für Dashboards)
      if (q.clean === '1' || q.clean === 'true') {
        return cleanMarkdown(vis === 'players' ? stripDmBlocks(note.body) : note.body)
      }
      return vis === 'players' ? stripDmBlocks(note.raw) : note.raw
    }
    if (q.format === 'html') {
      reply.type('text/html; charset=utf-8')
      return renderer(v).renderBody(note.body, { linkBase: q.link_base, ...renderAccess(req, v) })
    }
    return cleanJson(q, noteJson(v, note, { visibility: vis, fields: q.fields ? String(q.fields).split(',') : undefined, access: accessOf(req, v.id) }))
  })

  app.post('/vaults/:vault/notes', { schema: { tags: T.notes, summary: 'Notiz anlegen', body: noteBodySchema } }, async (req, reply) => {
    const v = vaultFor(req, s, 'write')
    const b = req.body as any
    if (b.type && !v.config.types[b.type]) throw invalid(`Unbekannter Typ: ${b.type}`, { types: Object.keys(v.config.types) })
    let frontmatter = b.frontmatter
    let folder = b.folder
    if (isAreaRestricted(req, v.id)) {
      // Im Bereich anlegen: Kampagne setzen, Typ und Ordner prüfen
      const area = accessOf(req, v.id)
      const type = b.type ?? 'note'
      const campaign = stripLink(frontmatter?.campaign) ?? area.campaign ?? null
      if (area.campaign && !frontmatter?.campaign) frontmatter = { ...(frontmatter ?? {}), campaign: area.campaign }
      if (!folder && area.folders?.length && !area.folders.some((f) => (v.folderFor(type, campaign, b.title) + '/').startsWith(f + '/'))) folder = area.folders[0]
      const target = (folder ?? v.folderFor(type, campaign, b.title)).replace(/^\/+|\/+$/g, '')
      assertInArea(req, v, { campaign, type, path: `${target ? target + '/' : ''}${b.title}.md` })
    }
    const note = await v.createNote({ type: b.type, title: b.title, frontmatter, body: b.body, folder, template: b.template })
    reply.code(201).header('ETag', `"${note.version}"`)
    return noteJson(v, note, { access: accessOf(req, v.id) })
  })

  app.put('/vaults/:vault/notes/:id', { schema: { tags: T.notes, summary: 'Notiz komplett ersetzen (If-Match erforderlich). Body: {raw} oder {frontmatter, body}' } }, async (req, reply) => {
    const v = vaultFor(req, s, 'write')
    const b = (req.body ?? {}) as any
    if (isAreaRestricted(req, v.id)) {
      const cur = noteFor(req, v, (req.params as any).id)
      const fm = typeof b.raw === 'string' ? parseNote(b.raw).frontmatter : (b.frontmatter ?? cur.frontmatter)
      assertInArea(req, v, { campaign: stripLink(fm.campaign), type: fm.type ? String(fm.type) : 'note', path: cur.path })
    }
    const note = await v.replaceNote((req.params as any).id, { raw: b.raw, frontmatter: b.frontmatter, body: b.body }, ifMatch(req.headers) ?? b.version)
    reply.header('ETag', `"${note.version}"`)
    return noteJson(v, note)
  })

  app.patch('/vaults/:vault/notes/:id', { schema: { tags: T.notes, summary: 'Teiländerung: frontmatter zusammenführen, remove, append {text, heading}' } }, async (req, reply) => {
    const v = vaultFor(req, s, 'write')
    const b = (req.body ?? {}) as any
    if (isAreaRestricted(req, v.id)) {
      const cur = noteFor(req, v, (req.params as any).id)
      const removed = new Set<string>(Array.isArray(b.remove) ? b.remove : [])
      const campaign = b.frontmatter && 'campaign' in b.frontmatter ? stripLink(b.frontmatter.campaign) : removed.has('campaign') ? null : cur.campaign
      const type = b.frontmatter?.type ? String(b.frontmatter.type) : removed.has('type') ? 'note' : cur.type
      assertInArea(req, v, { campaign, type, path: cur.path })
    }
    const note = await v.patchNote((req.params as any).id, { frontmatter: b.frontmatter, remove: b.remove, append: b.append }, ifMatch(req.headers))
    reply.header('ETag', `"${note.version}"`)
    return noteJson(v, note)
  })

  app.delete('/vaults/:vault/notes/:id', { schema: { tags: T.notes, summary: 'Notiz in den Papierkorb verschieben' } }, async (req) => {
    const v = vaultFor(req, s, 'write')
    noteFor(req, v, (req.params as any).id)
    return v.deleteNote((req.params as any).id)
  })

  app.post('/vaults/:vault/notes/:id/rename', { schema: { tags: T.notes, summary: 'Umbenennen/Verschieben {title?, folder?} – passt alle Links an' } }, async (req) => {
    const v = vaultFor(req, s, 'write')
    const b = (req.body ?? {}) as any
    const r = await v.renameNote((req.params as any).id, { title: b.title, folder: b.folder })
    return { ...noteJson(v, r.note), updated_links: r.updated_links, updated_notes: r.updated_notes }
  })

  app.get('/vaults/:vault/notes/:id/backlinks', { schema: { tags: T.notes, summary: 'Eingehende Links mit Kontext' } }, async (req) => {
    const v = vaultFor(req, s, 'read')
    const note = noteFor(req, v, (req.params as any).id)
    const vis = visibilityOf(req)
    const access = accessOf(req, v.id)
    const items = v
      .backlinks(note.id)
      .filter((b) => vis !== 'players' || (b.source_visibility === 'players' && !b.in_dm_block))
      .filter((b) => {
        const src = v.readNote(b.source_id)
        return !!src && restrictionAllows(access, src)
      })
    return { items }
  })

  app.get('/vaults/:vault/notes/:id/links', { schema: { tags: T.notes, summary: 'Ausgehende Links (aufgelöst/unaufgelöst)' } }, async (req) => {
    const v = vaultFor(req, s, 'read')
    const note = noteFor(req, v, (req.params as any).id)
    const vis = visibilityOf(req)
    const access = accessOf(req, v.id)
    const items = v
      .outgoing(note.id)
      .filter((l) => vis !== 'players' || !l.in_dm_block)
      .map((l) => {
        const t = l.target_id ? v.readNote(l.target_id) : null
        return !t || restrictionAllows(access, t) ? l : { ...l, target_id: null, target_title: null, target_type: null, resolved: false }
      })
    return { items }
  })

  app.get('/vaults/:vault/notes/:id/history', { schema: { tags: T.notes, summary: 'Versionen aus git' } }, async (req) => {
    const v = vaultFor(req, s, 'read')
    await v.flushCommit()
    return { items: await v.history((req.params as any).id) }
  })

  app.get('/vaults/:vault/notes/:id/history/:rev', { schema: { tags: T.notes, summary: 'Inhalt einer Version (?diff=1 als Diff zur aktuellen)' } }, async (req, reply) => {
    const v = vaultFor(req, s, 'read')
    const { id, rev } = req.params as any
    const content = await v.historyRev(id, rev)
    if (content === null) throw notFound('Version')
    const q = req.query as any
    if (q.diff === '1' || q.diff === 'true') {
      const cur = v.getNote(id)
      return { rev, diff: createTwoFilesPatch(`${rev.slice(0, 8)}/${cur.path}`, `aktuell/${cur.path}`, content, cur.raw, '', '', { context: 3 }) }
    }
    if (q.format === 'markdown') {
      reply.type('text/markdown; charset=utf-8')
      return content
    }
    return { rev, content }
  })

  app.post('/vaults/:vault/notes/:id/restore', { schema: { tags: T.notes, summary: 'Version wiederherstellen {rev}' } }, async (req) => {
    const v = vaultFor(req, s, 'write')
    const rev = (req.body as any)?.rev
    if (!rev) throw invalid('rev fehlt.')
    return noteJson(v, await v.restore((req.params as any).id, String(rev)))
  })

  // ------------------------------------------------------------ Aufgaben (Checklisten)

  app.get('/vaults/:vault/notes/:id/tasks', { schema: { tags: T.notes, summary: 'Aufgaben (- [ ] …) einer Notiz: {index, checked, text}' } }, async (req) => {
    const v = vaultFor(req, s, 'read')
    const note = noteFor(req, v, (req.params as any).id)
    const body = visibilityOf(req) === 'players' ? stripDmBlocks(note.body) : note.body
    return { items: listTasks(body).map(({ index, checked, text }) => ({ index, checked, text })), version: note.version }
  })

  app.post(
    '/vaults/:vault/notes/:id/tasks/:index',
    {
      schema: {
        tags: T.notes,
        summary: 'Aufgabe abhaken/zurücksetzen {checked, text?} – text prüft, dass es noch dieselbe Aufgabe ist (sonst 409)',
        body: { type: 'object', properties: { checked: { type: 'boolean' }, text: { type: 'string' } }, required: ['checked'] },
      },
    },
    async (req, reply) => {
      const v = vaultFor(req, s, 'write')
      const note = noteFor(req, v, (req.params as any).id)
      const index = Number((req.params as any).index)
      const b = req.body as any
      const task = listTasks(note.body)[index]
      if (!Number.isInteger(index) || !task) throw notFound('Aufgabe')
      // Angezeigter Text (ohne Markdown) gegen den Text in der Datei – nur grob, damit Formatierung nicht stört
      const plain = (t: string) =>
        t
          .replace(/!?\[\[([^\]|#]*)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g, (_m, a: string, h?: string, d?: string) => d ?? (h ? (a ? `${a} › ${h}` : h) : a))
          .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
          .replace(/[*_`~]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase()
      const shown = typeof b.text === 'string' ? plain(b.text) : ''
      const stored = plain(task.text)
      if (shown && !(shown === stored || shown.startsWith(stored) || stored.startsWith(shown))) {
        throw new ApiError('conflict', 'Die Liste wurde inzwischen geändert – bitte neu laden.', { current: task.text })
      }
      if (task.checked === b.checked) return noteJson(v, note, { access: accessOf(req, v.id) })
      const body = setTask(note.body, index, b.checked)
      // Nur das eine Zeichen ändern: Frontmatter bleibt byte-genau
      const prefix = note.raw.endsWith(note.body) ? note.raw.slice(0, note.raw.length - note.body.length) : null
      const updated = prefix !== null ? await v.replaceNote(note.id, { raw: prefix + body }, note.version) : await v.replaceNote(note.id, { body, frontmatter: note.frontmatter }, note.version)
      reply.header('ETag', `"${updated.version}"`)
      return noteJson(v, updated, { access: accessOf(req, v.id) })
    },
  )

  // ------------------------------------------------------------ Verknüpfen

  app.post(
    '/vaults/:vault/notes/:id/link',
    {
      schema: {
        tags: T.notes,
        summary: 'Erwähnungen vorhandener Notizen (Titel, Aliasse) verlinken – ohne LLM. {dry_run?, links?: [Titel]} → {linked, diff, note?}',
        body: { type: ['object', 'null'], properties: { dry_run: { type: 'boolean' }, links: { type: 'array', items: { type: 'string' } } } },
      },
    },
    async (req) => {
      const v = vaultFor(req, s, 'write')
      const note = noteFor(req, v, (req.params as any).id)
      const b = (req.body ?? {}) as any
      const access = accessOf(req, v.id)
      const p = parseNote(note.raw)
      const r = linkNoteBody(s.db, v.id, note.id, p.body, b.links, (t) => restrictionAllows(access, t))
      const after = composeNote(p.fmText, r.body)
      const diff = r.linked.length ? createTwoFilesPatch(`a/${note.path}`, `b/${note.path}`, note.raw, after, '', '', { context: 2 }) : ''
      if (b.dry_run || !r.linked.length) return { linked: r.linked, diff }
      const updated = await v.replaceNote(note.id, { raw: after }, note.version)
      return { linked: r.linked, diff, note: noteJson(v, updated, { access }) }
    },
  )

  // ------------------------------------------------------------ Tagebuch

  app.post(
    '/vaults/:vault/journal/today',
    {
      schema: {
        tags: T.notes,
        summary: 'Tagebuch-Eintrag für heute (oder {date: "YYYY-MM-DD"}) öffnen – wird angelegt, falls es ihn noch nicht gibt',
        body: { type: ['object', 'null'], properties: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } } },
      },
    },
    async (req, reply) => {
      const v = vaultFor(req, s, 'write')
      const b = (req.body ?? {}) as any
      const { note, created } = await journalFor(s, req, v, b.date)
      if (created) reply.code(201)
      return { ...noteJson(v, note, { access: accessOf(req, v.id) }), created }
    },
  )

  // ------------------------------------------------------------ Schnell erfassen (Home Assistant, Kurzbefehle, Skripte)

  app.post(
    '/vaults/:vault/capture',
    {
      schema: {
        tags: T.notes,
        summary:
          'Text schnell ablegen {text, to?: journal|list|note, list?: "Einkauf", title?} – journal: Zeile mit Uhrzeit im heutigen Tagebuch, list: Punkt auf einer Liste, note: neue Notiz',
        body: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string', minLength: 1, maxLength: 20000 },
            to: { type: 'string', enum: ['journal', 'list', 'note'] },
            list: { type: 'string' },
            title: { type: 'string' },
            heading: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const v = vaultFor(req, s, 'write')
      const b = req.body as any
      const text = String(b.text).trim()
      if (!text) throw invalid('text ist leer.')
      const to: 'journal' | 'list' | 'note' = b.to ?? (b.list ? 'list' : v.config.types.journal ? 'journal' : 'note')
      const access = accessOf(req, v.id)

      if (to === 'list') {
        if (!b.list) throw invalid('list fehlt (Titel der Liste, z. B. "Einkauf").')
        const cand = s.search.resolve(v, String(b.list), { type: v.config.types.list ? 'list' : undefined, access, limit: 1 })[0]
        if (!cand || cand.score < 0.9) throw notFound(`Liste „${b.list}“`)
        const note = noteFor(req, v, cand.id)
        const body = appendTask(note.body, text)
        const prefix = note.raw.endsWith(note.body) ? note.raw.slice(0, note.raw.length - note.body.length) : null
        const updated = prefix !== null ? await v.replaceNote(note.id, { raw: prefix + body }, note.version) : await v.replaceNote(note.id, { body, frontmatter: note.frontmatter }, note.version)
        return { to, note_id: updated.id, title: updated.title }
      }

      if (to === 'journal') {
        if (!v.config.types.journal) throw invalid('Dieses Notizbuch hat keinen Typ „Tagebuch“ (journal).')
        const { note } = await journalFor(s, req, v)
        const time = utcToLocal(Date.now()).slice(11, 16)
        const line = text.includes('\n') ? `- ${time}\n\n${text}\n` : `- ${time} ${text}`
        const updated = await v.patchNote(note.id, { append: { text: line, heading: b.heading ?? 'Heute' } }, undefined)
        return { to, note_id: updated.id, title: updated.title }
      }

      // Neue Notiz
      const title = String(b.title ?? '').trim() || text.split('\n')[0].replace(/[#*_`[\]]/g, '').slice(0, 60).trim() || 'Notiz'
      let frontmatter: Record<string, any> | undefined
      if (isAreaRestricted(req, v.id)) {
        if (access.campaign) frontmatter = { campaign: access.campaign }
        const folder = v.folderFor('note', access.campaign ?? null, title)
        assertInArea(req, v, { campaign: access.campaign ?? null, type: 'note', path: `${folder ? folder + '/' : ''}${title}.md` })
      }
      const note = await v.createNote({ type: 'note', title, frontmatter, body: `# ${title}\n\n${text}\n` })
      reply.code(201)
      return { to, note_id: note.id, title: note.title }
    },
  )

  // ------------------------------------------------------------ Verwaltete Bereiche

  app.put('/vaults/:vault/notes/:id/blocks/:key', { schema: { tags: T.blocks, summary: 'Bereich setzen/ersetzen {content, heading?, source_note?, visibility?}' } }, async (req) => {
    const v = vaultFor(req, s, 'write')
    const { id, key } = req.params as any
    noteFor(req, v, id)
    const b = (req.body ?? {}) as any
    if (typeof b.content !== 'string') throw invalid('content fehlt.')
    let source: string | null = null
    if (b.source_note) {
      const src = v.readNote(b.source_note) ?? (v.resolveName(b.source_note) ? v.readNote(v.resolveName(b.source_note)!) : null)
      source = src ? `[[${src.title}]]` : String(b.source_note)
    }
    const note = await v.putBlock(id, { key, content: b.content, heading: b.heading ?? null, source, visibility: b.visibility ?? null })
    return noteJson(v, note)
  })

  app.delete('/vaults/:vault/notes/:id/blocks/:key', { schema: { tags: T.blocks, summary: 'Bereich entfernen' } }, async (req) => {
    const v = vaultFor(req, s, 'write')
    const { id, key } = req.params as any
    noteFor(req, v, id)
    const removed = await v.deleteBlock(id, key)
    if (!removed) throw notFound('Bereich')
    return { removed: true }
  })

  app.delete('/vaults/:vault/blocks', { schema: { tags: T.blocks, summary: 'Alle Bereiche einer Quelle entfernen (?key=…, &prefix=1 inkl. Unterschlüssel)' } }, async (req) => {
    const v = vaultFor(req, s, 'write')
    const q = req.query as any
    if (!q.key) throw invalid('key fehlt.')
    const removed = await v.deleteBlocksByKey(String(q.key), { prefix: q.prefix === '1' || q.prefix === 'true' })
    return { removed }
  })

  // ------------------------------------------------------------ Darstellung & Anhänge

  app.get('/vaults/:vault/notes/:id/html', { schema: { tags: T.render, summary: 'Bereinigtes HTML (?link_base=/wiki/{vault}/{id}&visibility=dm|players)' } }, async (req, reply) => {
    const v = vaultFor(req, s, 'read')
    const note = noteFor(req, v, (req.params as any).id)
    const q = req.query as any
    reply.type('text/html; charset=utf-8').header('ETag', `"${note.version}"`)
    // ?tasks=1: Aufgaben anklickbar (nur mit Schreibrecht)
    let interactiveTasks = false
    if (q.tasks === '1') {
      try {
        requireScope(req, 'write', v.id)
        interactiveTasks = true
      } catch {
        interactiveTasks = false
      }
    }
    return renderer(v).renderBody(note.body, { linkBase: q.link_base, ...renderAccess(req, v), interactiveTasks })
  })

  app.post('/vaults/:vault/render', { schema: { tags: T.render, summary: 'Beliebiges Markdown im Kontext des Vaults rendern {markdown}' } }, async (req, reply) => {
    const v = vaultFor(req, s, 'read')
    const b = (req.body ?? {}) as any
    reply.type('text/html; charset=utf-8')
    return renderer(v).renderBody(String(b.markdown ?? ''), { linkBase: b.link_base, ...renderAccess(req, v) })
  })

  app.get('/vaults/:vault/attachments/*', { schema: { tags: T.render, summary: 'Anhang abrufen' } }, async (req, reply) => {
    const v = vaultFor(req, s, 'read')
    const name = decodeURIComponent((req.params as any)['*'] ?? '')
    const file = v.attachmentFile(name)
    if (!file) throw notFound('Anhang')
    const ext = path.extname(file).toLowerCase()
    reply.type(MIME[ext] ?? 'application/octet-stream').header('Cache-Control', 'private, max-age=3600')
    if (ext === '.svg') reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
    return reply.send(fs.createReadStream(file))
  })

  app.post('/vaults/:vault/attachments', { schema: { tags: T.render, summary: 'Anhang hochladen (multipart, Feld "file")' } }, async (req, reply) => {
    const v = vaultFor(req, s, 'write')
    const file = await (req as any).file?.()
    if (!file) throw invalid('Datei fehlt (multipart-Feld "file").')
    const buf: Buffer = await file.toBuffer()
    const rel = v.saveAttachment(file.filename || 'datei', buf)
    reply.code(201)
    const name = path.posix.basename(rel)
    return { name, path: rel, url: `/api/v1/vaults/${encodeURIComponent(v.id)}/attachments/${encodeURIComponent(name)}`, embed: `![[${name}]]` }
  })

  // ------------------------------------------------------------ Kurator für eine Notiz

  app.post('/vaults/:vault/notes/:id/curate', { schema: { tags: T.curator, summary: 'Bestehende Notiz durch den Kurator schicken (?dry_run=1 zeigt nur den Plan, ?mode=review)' } }, async (req, reply) => {
    const v = vaultFor(req, s, 'curate')
    const q = req.query as any
    const id = (req.params as any).id
    const mode = q.mode === 'review' ? 'review' : 'auto'
    if (q.dry_run === '1' || q.dry_run === 'true' || q.wait === '1') {
      // Schließt der Browser den Dialog, wird auch die LLM-Anfrage abgebrochen
      const ctrl = new AbortController()
      const onClose = () => {
        if (!reply.raw.writableEnded) ctrl.abort()
      }
      req.raw.on('close', onClose)
      try {
        return await s.inbox.curateNote(v.id, id, { mode, dryRun: q.dry_run === '1' || q.dry_run === 'true', signal: ctrl.signal })
      } finally {
        req.raw.off('close', onClose)
      }
    }
    const jobId = s.inbox.enqueueCurateNote(v.id, id, mode)
    reply.code(202)
    return { status: 'queued', job_id: jobId }
  })

}
