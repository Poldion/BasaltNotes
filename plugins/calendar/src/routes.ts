import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ServerPluginContext } from '@basaltnotes/plugin-sdk'
import { calendarItems, checkDate, type CalendarItem } from './calendar.js'
import { H } from './h.js'

const tags = ['Kalender (Plugin)']

/** Zeitraum aus ?from&to (Standard: heute − 7 bis + 42 Tage) */
function range(req: FastifyRequest): { from: string; to: string } {
  const q = req.query as any
  const today = new Date()
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const from = q.from ? checkDate(q.from, 'from') : iso(new Date(today.getTime() - 7 * 86400000))
  const to = q.to ? checkDate(q.to, 'to') : iso(new Date(today.getTime() + 42 * 86400000))
  return { from, to }
}

export function registerCalendar(app: FastifyInstance, ctx: ServerPluginContext) {
  app.get(
    '/vaults/:vault/calendar',
    { schema: { tags, summary: 'Kalender eines Notizbuchs: Termine, fällige Aufgaben, Sessions … (?from=JJJJ-MM-TT&to=JJJJ-MM-TT, Wiederholungen aufgelöst)' } },
    async (req) => {
      const v = H.vaultFor(req, 'read')
      const { from, to } = range(req)
      return { from, to, items: calendarItems(ctx.db, v, from, to, H.accessOf(req, v.id)) }
    },
  )

  app.get('/calendar', { schema: { tags, summary: 'Kalender über alle zugänglichen Notizbücher (?from, to, vaults=a,b)' } }, async (req) => {
    const { from, to } = range(req)
    const want = (req.query as any).vaults ? String((req.query as any).vaults).split(',') : null
    const items: CalendarItem[] = []
    for (const v of ctx.vaults.list()) {
      if (want && !want.includes(v.id)) continue
      try {
        H.requireScope(req, 'read', v.id)
      } catch {
        continue
      }
      items.push(...calendarItems(ctx.db, v, from, to, H.accessOf(req, v.id)))
    }
    items.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title, 'de'))
    return { from, to, items }
  })

  // Auch für Zugänge mit Bereichs-Einschränkung (gefiltert wie alles andere)
  ctx.allowArea('GET', '/vaults/:vault/calendar', 'read')
  ctx.allowArea('GET', '/calendar', 'read')
}
