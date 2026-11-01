import type { FastifyInstance } from 'fastify'
import type { ServerPluginContext, VaultApi } from '@basaltnotes/plugin-sdk'

function recapExcerpt(sdk: ServerPluginContext['helpers'], body: string, players: boolean, max = 600): string {
  const text = players ? sdk.stripDmBlocks(body) : body
  const hs = sdk.headings(text)
  const h = hs.find((x) => /was bisher geschah|zusammenfassung|recap/i.test(x.text))
  let section = text
  if (h) {
    const next = hs.find((x) => x.index > h.index && x.level <= h.level)
    section = text.slice(text.indexOf('\n', h.index) + 1, next ? next.index : undefined)
  } else {
    const recap = sdk.listBlocks(text).find((b: any) => b.key.endsWith(':recap'))
    if (recap) section = recap.content
  }
  const clean = sdk.stripBlockMarkers(section)
    .replace(/^#+\s.*$/gm, '')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.length > max ? clean.slice(0, max).replace(/\s\S*$/, '') + ' …' : clean
}

/** Kampagne über ID, Titel oder Kurzform finden. */
function findCampaign(ctx: ServerPluginContext, v: VaultApi, key: string) {
  const rows = ctx.db.all<any>("SELECT id, title, frontmatter, visibility FROM notes WHERE vault = ? AND type = 'campaign'", v.id)
  const hit = rows.find((r) => r.id === key || r.title.toLowerCase() === key.toLowerCase() || ctx.helpers.slugify(r.title) === ctx.helpers.slugify(key))
  if (hit) return { id: hit.id as string, title: hit.title as string, frontmatter: ctx.helpers.json<Record<string, any>>(hit.frontmatter, {}), visibility: hit.visibility as string | null }
  // Kampagne ohne eigene Notiz (nur als Eigenschaft vorhanden)
  const camp = ctx.db.all<{ campaign: string }>('SELECT DISTINCT campaign FROM notes WHERE vault = ? AND campaign IS NOT NULL', v.id).find((c) => ctx.helpers.slugify(c.campaign) === ctx.helpers.slugify(key))
  if (camp) return { id: null, title: camp.campaign, frontmatter: {} as Record<string, any>, visibility: null }
  throw ctx.helpers.error('not_found', 'Kampagne nicht gefunden.')
}

/** Kurzfassung „Was bisher geschah“ bzw. erster Absatz. */

/** Kampagnen: Liste, Startseite, Timeline */
export function registerCampaigns(app: FastifyInstance, ctx: ServerPluginContext) {
  const h = ctx.helpers
  ctx.allowArea('GET', '/vaults/:vault/campaigns', 'read')
  ctx.allowArea('GET', '/vaults/:vault/campaigns/:campaign/overview', 'read')
  ctx.allowArea('GET', '/vaults/:vault/campaigns/:campaign/timeline', 'read')

  app.get('/vaults/:vault/campaigns', { schema: { tags: ['Kampagnen'], summary: 'Kampagnen' } }, async (req) => {
    const v = h.vaultFor(req, 'read')
    const players = h.visibilityOf(req) === 'players'
    const notes = ctx.db.all<any>(`SELECT id, title, frontmatter, updated, visibility FROM notes WHERE vault = ? AND type = 'campaign' ${players ? "AND visibility = 'players'" : ''} ORDER BY title`, v.id)
    const items = notes.map((n) => {
      const fm = h.json<Record<string, any>>(n.frontmatter, {})
      return { id: n.id, title: n.title, slug: h.slugify(n.title), status: fm.status ?? null, system: fm.system ?? null, players: fm.players ?? [], updated: n.updated }
    })
    // Kampagnen, die nur als Eigenschaft vorkommen
    for (const c of ctx.db.all<{ campaign: string }>(`SELECT DISTINCT campaign FROM notes WHERE vault = ? AND campaign IS NOT NULL ${players ? "AND visibility = 'players'" : ''}`, v.id)) {
      if (!items.some((i) => i.title.toLowerCase() === c.campaign.toLowerCase())) items.push({ id: null as any, title: c.campaign, slug: h.slugify(c.campaign), status: null, system: null, players: [], updated: null })
    }
    const pc = h.accessOf(req, v.id).campaign
    return { items: pc ? items.filter((i) => i.title.toLowerCase() === pc.toLowerCase()) : items }
  })

  app.get('/vaults/:vault/campaigns/:campaign/overview', { schema: { tags: ['Kampagnen'], summary: 'Alles für die Kampagnen-Startseite in einem Aufruf (?visibility=dm|players)' } }, async (req) => {
    const v = h.vaultFor(req, 'read')
    const c = findCampaign(ctx, v, (req.params as any).campaign)
    const access = h.accessOf(req, v.id)
    if (access.campaign && access.campaign.toLowerCase() !== c.title.toLowerCase()) throw h.error('not_found', 'Kampagne nicht gefunden.')
    const players = h.visibilityOf(req) === 'players'
    const visSql = players ? "AND visibility = 'players'" : ''
    const rows = ctx.db
      .all<any>(`SELECT id, type, title, campaign, path, visibility, frontmatter, body, updated, created FROM notes WHERE vault = ? AND lower(campaign) = lower(?) ${visSql}`, v.id, c.title)
      .filter((r) => h.restrictionAllows(access, r))
    const fmOf = (r: any) => h.json<Record<string, any>>(r.frontmatter, {})
    const sessions = rows
      .filter((r) => r.type === 'session')
      .map((r) => ({ r, fm: fmOf(r) }))
      .sort((a, b) => (Number(b.fm.number) || 0) - (Number(a.fm.number) || 0) || String(b.fm.date ?? b.r.created ?? '').localeCompare(String(a.fm.date ?? a.r.created ?? '')))
    const last = sessions[0]
    const counts: Record<string, number> = {}
    for (const r of rows) if (!['session', 'campaign', 'fact', 'script'].includes(r.type)) counts[r.type] = (counts[r.type] ?? 0) + 1
    return {
      campaign: { id: c.id, title: c.title, slug: h.slugify(c.title), status: c.frontmatter.status ?? null, system: c.frontmatter.system ?? null, players: c.frontmatter.players ?? [], dm: c.frontmatter.dm ?? null },
      last_session: last ? { id: last.r.id, title: last.r.title, number: last.fm.number ?? null, date: last.fm.date ?? null, recap_excerpt: recapExcerpt(h, last.r.body, players) } : null,
      sessions: sessions.map(({ r, fm }) => ({ id: r.id, number: fm.number ?? null, date: fm.date ?? null, title: r.title })),
      open_quests: rows
        .filter((r) => r.type === 'quest' && ['offen', 'open', ''].includes(String(fmOf(r).status ?? 'offen').toLowerCase()))
        .map((r) => ({ id: r.id, title: r.title, status: fmOf(r).status ?? 'offen', giver: fmOf(r).giver ?? null, updated: r.updated })),
      characters: rows.filter((r) => r.type === 'character').map((r) => ({ id: r.id, title: r.title, player: fmOf(r).player ?? null, class: fmOf(r).class ?? null, status: fmOf(r).status ?? null })),
      recent_entities: rows
        .filter((r) => ['npc', 'monster', 'location', 'faction', 'item', 'quest', 'character'].includes(r.type))
        .sort((a, b) => String(b.updated ?? '').localeCompare(String(a.updated ?? '')))
        .slice(0, 12)
        .map((r) => ({ id: r.id, type: r.type, title: r.title, updated: r.updated })),
      counts,
      scripts: players
        ? []
        : rows
            .filter((r) => r.type === 'script' && String(fmOf(r).status ?? 'geplant').toLowerCase() === 'geplant')
            .map((r) => ({ id: r.id, title: r.title, planned_for: fmOf(r).planned_for ?? null, updated: r.updated }))
            .sort((a, b) => String(a.planned_for ?? '9999').localeCompare(String(b.planned_for ?? '9999'))),
      open_proposals: players ? 0 : (ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM proposals WHERE vault = ? AND status = 'open' AND (campaign IS NULL OR lower(campaign) = lower(?))", v.id, c.title)?.n ?? 0),
    }
  })

  app.get('/vaults/:vault/campaigns/:campaign/timeline', { schema: { tags: ['Kampagnen'], summary: 'Sessions chronologisch mit Kurz-Recap' } }, async (req) => {
    const v = h.vaultFor(req, 'read')
    const c = findCampaign(ctx, v, (req.params as any).campaign)
    const access = h.accessOf(req, v.id)
    if (access.campaign && access.campaign.toLowerCase() !== c.title.toLowerCase()) throw h.error('not_found', 'Kampagne nicht gefunden.')
    const players = h.visibilityOf(req) === 'players'
    const rows = ctx.db
      .all<any>(
        `SELECT id, title, type, campaign, path, visibility, frontmatter, body, created FROM notes WHERE vault = ? AND type = 'session' AND lower(campaign) = lower(?) ${players ? "AND visibility = 'players'" : ''}`,
        v.id,
        c.title,
      )
      .filter((r) => h.restrictionAllows(access, r))
    const items = rows
      .map((r) => {
        const fm = h.json<Record<string, any>>(r.frontmatter, {})
        return { id: r.id, title: r.title, number: fm.number ?? null, date: fm.date ?? null, transcript_url: fm.transcript_url ?? null, recap_excerpt: recapExcerpt(h, r.body, players, 400), _sort: String(fm.date ?? r.created ?? '') }
      })
      .sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0) || a._sort.localeCompare(b._sort))
      .map(({ _sort, ...rest }) => rest)
    return { campaign: c.title, items }
  })
}
