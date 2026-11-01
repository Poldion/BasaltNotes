import type { FastifyInstance } from 'fastify'
import { json } from '../db.js'
import { notFound } from '../lib/errors.js'
import { slugify } from '../lib/util.js'
import { headings, listBlocks, stripBlockMarkers, stripDmBlocks } from '../notes/markdown.js'
import type { Vault } from '../notes/vault.js'
import { restrictionAllows } from '../notes/search.js'
import { Register, Services, T, accessOf, vaultFor, visibilityOf } from './common.js'

export const registerSearch: Register = (app: FastifyInstance, s: Services) => {
  app.get('/vaults/:vault/search', { schema: { tags: T.search, summary: 'Volltextsuche mit Treffer-Ausschnitten (?q, type, campaign, tag, limit, cursor)' } }, async (req) => {
    const v = vaultFor(req, s, 'read')
    const q = req.query as any
    return s.search.search(v.id, String(q.q ?? ''), { type: q.type, campaign: q.campaign, tag: q.tag, limit: q.limit, cursor: q.cursor }, accessOf(req, v.id))
  })

  app.post(
    '/vaults/:vault/query',
    {
      schema: {
        tags: T.search,
        summary: 'Strukturierte Abfrage (Dataview-ähnlich)',
        body: {
          type: 'object',
          properties: {
            where: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, op: { type: 'string' }, value: {} }, required: ['field'] } },
            sort: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } } } },
            select: { type: 'array', items: { type: 'string' } },
            limit: { type: 'integer' },
            cursor: { type: 'string' },
            q: { type: 'string' },
          },
        },
      },
    },
    async (req) => {
      const v = vaultFor(req, s, 'read')
      const b = { ...((req.body ?? {}) as any) }
      return s.search.query(v.id, b, accessOf(req, v.id))
    },
  )

  app.get('/vaults/:vault/resolve', { schema: { tags: T.search, summary: 'Kandidaten für einen Namen mit Score (?name, type, campaign)' } }, async (req) => {
    const v = vaultFor(req, s, 'read')
    const q = req.query as any
    return { items: s.search.resolve(v, String(q.name ?? ''), { type: q.type, campaign: q.campaign, limit: Number(q.limit) || 5, access: accessOf(req, v.id) }) }
  })

  app.get('/vaults/:vault/names', { schema: { tags: T.search, summary: 'Alle Titel + Aliasse kompakt (?campaign, types=npc,location) – z. B. als Whisper-Glossar' } }, async (req) => {
    const v = vaultFor(req, s, 'read')
    const q = req.query as any
    return s.search.names(v.id, { campaign: q.campaign, types: q.types ? String(q.types).split(',') : undefined, visibility: accessOf(req, v.id) })
  })

  app.get('/vaults/:vault/tags', { schema: { tags: T.search, summary: 'Tags mit Anzahl' } }, async (req) => {
    const v = vaultFor(req, s, 'read')
    return { items: s.search.tags(v.id) }
  })

  app.get('/vaults/:vault/graph', { schema: { tags: T.search, summary: 'Knoten + Kanten (?campaign, type)' } }, async (req) => {
    const v = vaultFor(req, s, 'read')
    const q = req.query as any
    return s.search.graph(v, { campaign: q.campaign, types: q.type ? String(q.type).split(',') : undefined, visibility: accessOf(req, v.id) })
  })


}
