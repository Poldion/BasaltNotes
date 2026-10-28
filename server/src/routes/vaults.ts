import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { FastifyInstance } from 'fastify'
import { requireScope } from '../auth.js'
import { ApiError, invalid, notFound } from '../lib/errors.js'
import { PROP_TYPES } from '../notes/presets.js'
import { safeFileName, writeFileAtomic } from '../lib/util.js'
import type { Vault } from '../notes/vault.js'
import { createExampleVault } from '../notes/example.js'
import { requestLang } from '../i18n.js'
import { Register, Services, T, noteJson, vaultFor, visibilityOf } from './common.js'

function vaultSummary(s: Services, v: Vault) {
  return {
    id: v.id,
    name: v.config.name,
    preset: v.config.preset,
    note_count: v.count(),
    types: Object.keys(v.config.types),
    curator: { enabled: v.config.curator.enabled, profile: v.config.curator.profile, mode: v.config.curator.mode ?? 'full' },
    open_proposals: s.db.get<{ n: number }>("SELECT COUNT(*) n FROM proposals WHERE vault = ? AND status = 'open'", v.id)?.n ?? 0,
    inbox_pending: s.db.get<{ n: number }>("SELECT COUNT(*) n FROM inbox WHERE vault = ? AND status IN ('queued','running')", v.id)?.n ?? 0,
  }
}

export const registerVaults: Register = (app: FastifyInstance, s: Services) => {
  app.get('/vaults', { schema: { tags: T.vaults, summary: 'Vaults auflisten' } }, async (req) => {
    const p = req.principal!
    const items = s.vaults.list().filter((v) => p.vaults === '*' || p.vaults.includes(v.id))
    return { items: items.map((v) => vaultSummary(s, v)) }
  })

  app.post(
    '/vaults',
    {
      schema: {
        tags: T.vaults,
        summary: 'Vault anlegen {name, preset: dnd|notes|empty, lang?: de|en} – empty = frei (nur „Notiz“, Kurator verknüpft nur); lang = Sprache der Ordnernamen (Standard: Sprache der Anfrage)',
        body: { type: 'object', properties: { name: { type: 'string' }, preset: { type: 'string', enum: ['dnd', 'notes', 'empty'] }, lang: { type: 'string', enum: ['de', 'en'] } }, required: ['name'] },
      },
    },
    async (req, reply) => {
      requireScope(req, 'admin')
      const b = req.body as any
      const v = await s.vaults.create(b.name, b.preset ?? 'empty', b.lang ?? requestLang(req))
      reply.code(201)
      return vaultSummary(s, v)
    },
  )

  app.post('/vaults/example', { schema: { tags: T.vaults, summary: 'Beispiel-Vault mit einer erfundenen Kampagne anlegen (zum Ausprobieren)' } }, async (req, reply) => {
    requireScope(req, 'admin')
    const v = await createExampleVault(s.vaults)
    reply.code(201)
    return vaultSummary(s, v)
  })

  app.get('/vaults/:vault', { schema: { tags: T.vaults, summary: 'Vault-Details' } }, async (req) => {
    const v = vaultFor(req, s, 'read')
    return { ...vaultSummary(s, v), config: { name: v.config.name, curator: v.config.curator } }
  })

  app.patch('/vaults/:vault', { schema: { tags: T.vaults, summary: 'Vault umbenennen / Einstellungen ändern {name?, curator?}' } }, async (req) => {
    const v = vaultFor(req, s, 'admin')
    const b = (req.body ?? {}) as any
    if (b.name) await s.vaults.rename(v.id, b.name)
    if (b.curator && typeof b.curator === 'object') {
      if (b.curator.mode !== undefined && !['full', 'link'].includes(b.curator.mode)) throw invalid('curator.mode muss full oder link sein.')
      v.updateConfig({ curator: { ...v.config.curator, ...b.curator } })
    }
    return vaultSummary(s, v)
  })

  app.delete('/vaults/:vault', { schema: { tags: T.vaults, summary: 'Vault löschen (wird nach data/deleted-vaults verschoben)' } }, async (req) => {
    const v = vaultFor(req, s, 'admin')
    await s.vaults.delete(v.id)
    return { deleted: v.id }
  })

  app.get('/vaults/:vault/types', { schema: { tags: T.vaults, summary: 'Typen mit Eigenschafts-Schema und Ordnern' } }, async (req) => {
    const v = vaultFor(req, s, 'read')
    return { items: v.typesSchema() }
  })

  app.get('/vaults/:vault/types/:name', { schema: { tags: T.vaults, summary: 'Ein Typ mit Vorlage (Markdown)' } }, async (req) => {
    const v = vaultFor(req, s, 'read')
    const name = (req.params as any).name
    const t = v.typesSchema().find((x) => x.name === name)
    if (!t) throw notFound('Typ')
    const count = s.db.get<{ n: number }>('SELECT COUNT(*) n FROM notes WHERE vault = ? AND type = ?', v.id, name)?.n ?? 0
    return { ...t, properties: v.config.types[name]?.properties ?? [], template_body: v.templateText(name), note_count: count }
  })

  app.put(
    '/vaults/:vault/types/:name',
    {
      schema: {
        tags: T.vaults,
        summary: 'Typ anlegen/ändern {label, folder, properties: [{name, label, type, options?, link_types?}], template_body?} (admin)',
        body: {
          type: 'object',
          required: ['label'],
          properties: {
            label: { type: 'string', minLength: 1, maxLength: 60 },
            folder: { type: 'string', maxLength: 200 },
            template_body: { type: ['string', 'null'], maxLength: 20000 },
            properties: {
              type: 'array',
              maxItems: 40,
              items: {
                type: 'object',
                required: ['name', 'type'],
                properties: {
                  name: { type: 'string' },
                  label: { type: 'string' },
                  type: { type: 'string', enum: PROP_TYPES },
                  options: { type: 'array', items: { type: 'string' } },
                  link_types: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
    async (req) => {
      const v = vaultFor(req, s, 'admin')
      const name = String((req.params as any).name)
      if (!/^[a-z][a-z0-9_-]{0,30}$/.test(name)) throw invalid('Name: Kleinbuchstaben, Ziffern, _ oder -, beginnt mit einem Buchstaben (z. B. "rezept").')
      const b = req.body as any
      const folder = String(b.folder ?? '').trim().replace(/^\/+|\/+$/g, '')
      if (folder.split('/').includes('..')) throw invalid('Ungültiger Ordner.')
      const reserved = new Set(['id', 'type', 'title', 'aliases', 'tags', 'created', 'updated', 'visibility'])
      const seen = new Set<string>()
      const properties = (b.properties ?? []).map((pd: any) => {
        const pn = String(pd.name).trim()
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(pn)) throw invalid(`Ungültiger Feldname: „${pn}“ (Buchstaben, Ziffern, _).`)
        if (reserved.has(pn)) throw invalid(`„${pn}“ ist reserviert.`)
        if (seen.has(pn)) throw invalid(`Feld „${pn}“ ist doppelt.`)
        seen.add(pn)
        const out: Record<string, any> = { name: pn, label: String(pd.label ?? '').trim() || pn, type: pd.type }
        if (pd.type === 'select') {
          const opts = (pd.options ?? []).map((o: any) => String(o).trim()).filter(Boolean)
          if (!opts.length) throw invalid(`Auswahlfeld „${out.label}“ braucht Optionen.`)
          out.options = opts
        }
        if (pd.type === 'link' && pd.link_types?.length) out.link_types = pd.link_types.map(String)
        return out
      })
      v.setType(name, { label: String(b.label).trim(), folder, properties }, b.template_body)
      s.events.emit('vault.types_changed', v.id, { type: name })
      return v.typesSchema().find((x) => x.name === name)
    },
  )

  app.delete('/vaults/:vault/types/:name', { schema: { tags: T.vaults, summary: 'Typ entfernen – nur ohne Notizen dieses Typs (admin)' } }, async (req) => {
    const v = vaultFor(req, s, 'admin')
    const name = String((req.params as any).name)
    if (!v.config.types[name]) throw notFound('Typ')
    if (name === 'note') throw invalid('Der Grundtyp „Notiz“ kann nicht entfernt werden.')
    const count = s.db.get<{ n: number }>('SELECT COUNT(*) n FROM notes WHERE vault = ? AND type = ?', v.id, name)?.n ?? 0
    if (count) throw new ApiError('conflict', `Es gibt noch ${count} Notiz(en) vom Typ „${v.config.types[name].label ?? name}“.`)
    v.deleteType(name)
    s.events.emit('vault.types_changed', v.id, { type: name, deleted: true })
    return { deleted: name }
  })

  app.post('/vaults/:vault/reindex', { schema: { tags: T.vaults, summary: 'Index neu aufbauen' } }, async (req) => {
    const v = vaultFor(req, s, 'write')
    const r = await v.reindex()
    s.events.emit('vault.reindexed', v.id, r)
    return r
  })

  app.get('/vaults/:vault/config', { schema: { tags: T.vaults, summary: 'vault.yaml lesen' } }, async (req) => {
    const v = vaultFor(req, s, 'admin')
    return { yaml: v.rawConfigText(), parsed: v.config }
  })

  app.put('/vaults/:vault/config', { schema: { tags: T.vaults, summary: 'vault.yaml ersetzen {yaml}' } }, async (req) => {
    const v = vaultFor(req, s, 'admin')
    const yaml = (req.body as any)?.yaml
    if (typeof yaml !== 'string') throw invalid('yaml fehlt.')
    try {
      v.saveConfigText(yaml)
    } catch (e) {
      throw invalid(`Ungültiges YAML: ${(e as Error).message}`)
    }
    return { yaml: v.rawConfigText(), parsed: v.config }
  })

  // ------------------------------------------------------------ Dateibaum & Ordner

  app.get('/vaults/:vault/tree', { schema: { tags: T.vaults, summary: 'Ordner und Notizen für den Dateibaum' } }, async (req) => {
    const v = vaultFor(req, s, 'read')
    const vis = visibilityOf(req)
    const notes = s.db.all<any>(`SELECT id, path, title, type, visibility FROM notes WHERE vault = ? ${vis === 'players' ? "AND visibility = 'players'" : ''} ORDER BY path COLLATE NOCASE`, v.id)
    return { folders: vis === 'players' ? [] : v.listFolders(), notes }
  })

  app.post('/vaults/:vault/folders', { schema: { tags: T.vaults, summary: 'Ordner anlegen {path}' } }, async (req, reply) => {
    const v = vaultFor(req, s, 'write')
    v.createFolder(String((req.body as any)?.path ?? ''))
    reply.code(201)
    return { folders: v.listFolders() }
  })

  app.patch('/vaults/:vault/folders', { schema: { tags: T.vaults, summary: 'Ordner umbenennen/verschieben {from, to}' } }, async (req) => {
    const v = vaultFor(req, s, 'write')
    const b = (req.body ?? {}) as any
    const moved = await v.renameFolder(String(b.from ?? ''), String(b.to ?? ''))
    return { moved, folders: v.listFolders() }
  })

  app.delete('/vaults/:vault/folders', { schema: { tags: T.vaults, summary: 'Ordner löschen (?path=…; Notizen wandern in den Papierkorb)' } }, async (req) => {
    const v = vaultFor(req, s, 'write')
    const deleted = await v.deleteFolder(String((req.query as any)?.path ?? ''))
    return { deleted }
  })

  // ------------------------------------------------------------ Papierkorb

  app.get('/vaults/:vault/trash', { schema: { tags: T.vaults, summary: 'Papierkorb' } }, async (req) => {
    const v = vaultFor(req, s, 'read')
    return { items: v.listTrash() }
  })

  app.post('/vaults/:vault/trash/restore', { schema: { tags: T.vaults, summary: 'Aus dem Papierkorb wiederherstellen {path}' } }, async (req) => {
    const v = vaultFor(req, s, 'write')
    const note = await v.restoreFromTrash(String((req.body as any)?.path ?? ''))
    return noteJson(v, note)
  })

  app.delete('/vaults/:vault/trash', { schema: { tags: T.vaults, summary: 'Papierkorb leeren (Verlauf bleibt in git)' } }, async (req) => {
    const v = vaultFor(req, s, 'admin')
    v.emptyTrash()
    return { emptied: true }
  })

  // ------------------------------------------------------------ Vorlagen

  app.get('/vaults/:vault/templates', { schema: { tags: T.vaults, summary: 'Vorlagen je Typ' } }, async (req) => {
    const v = vaultFor(req, s, 'read')
    return {
      items: v.listTemplates().map((name) => ({ name, content: fs.readFileSync(path.join(v.dir, '.basalt', 'templates', `${name}.md`), 'utf8') })),
    }
  })

  app.put('/vaults/:vault/templates/:name', { schema: { tags: T.vaults, summary: 'Vorlage speichern {content} – Platzhalter {{title}}, {{date}}, {{campaign}}' } }, async (req) => {
    const v = vaultFor(req, s, 'write')
    const name = safeFileName((req.params as any).name)
    const content = (req.body as any)?.content
    if (typeof content !== 'string') throw invalid('content fehlt.')
    writeFileAtomic(path.join(v.dir, '.basalt', 'templates', `${name}.md`), content)
    v.scheduleCommit(`Vorlage ${name}`)
    return { name, content }
  })

  app.delete('/vaults/:vault/templates/:name', { schema: { tags: T.vaults, summary: 'Vorlage löschen' } }, async (req) => {
    const v = vaultFor(req, s, 'write')
    const file = path.join(v.dir, '.basalt', 'templates', `${safeFileName((req.params as any).name)}.md`)
    if (!fs.existsSync(file)) throw notFound('Vorlage')
    fs.rmSync(file)
    v.scheduleCommit('Vorlage gelöscht')
    return { deleted: true }
  })

  // ------------------------------------------------------------ Export

  app.get('/vaults/:vault/export.zip', { schema: { tags: T.vaults, summary: 'Vault als ZIP (aktueller Stand aus git)' } }, async (req, reply) => {
    const v = vaultFor(req, s, 'read')
    await v.flushCommit()
    const child = spawn('git', ['archive', '--format=zip', 'HEAD'], { cwd: v.dir })
    reply
      .type('application/zip')
      .header('Content-Disposition', `attachment; filename="${v.id}-${new Date().toISOString().slice(0, 10)}.zip"`)
    return reply.send(child.stdout)
  })
}
