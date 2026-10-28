import crypto from 'node:crypto'
import { ulid } from 'ulid'
import { Db, json, nowIso } from './db.js'
import { EVENT_TYPES, EventBus, type BasaltEvent } from './events.js'
import { JobQueue } from './jobs.js'
import { invalid, notFound } from './lib/errors.js'
import { randomToken } from './lib/util.js'

export function sign(secret: string, body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex')
}

export class Webhooks {
  constructor(
    private db: Db,
    events: EventBus,
    private jobs: JobQueue,
  ) {
    events.on((e) => this.dispatch(e))
    jobs.register('webhook', (p, job) => this.deliver(p.delivery_id, job.attempts))
  }

  list() {
    return this.db.all<any>('SELECT id, url, events, vaults, active, created FROM webhooks ORDER BY created').map((r) => ({
      ...r,
      events: json(r.events, []),
      vaults: json(r.vaults, []),
      active: !!r.active,
      deliveries: this.db.all<any>('SELECT id, event, status, attempts, response_code, error, created, updated FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created DESC LIMIT 20', r.id),
    }))
  }

  create(input: { url: string; events?: string[]; vaults?: string[]; secret?: string }) {
    try {
      const u = new URL(input.url)
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error()
    } catch {
      throw invalid('Ungültige URL.')
    }
    const events = input.events?.length ? input.events : ['*']
    for (const e of events) if (e !== '*' && !EVENT_TYPES.includes(e as any)) throw invalid(`Unbekanntes Ereignis: ${e}`)
    const id = ulid()
    const secret = input.secret || randomToken(24)
    this.db.run(
      'INSERT INTO webhooks (id, url, events, vaults, secret, active, created) VALUES (?,?,?,?,?,1,?)',
      id,
      input.url,
      JSON.stringify(events),
      JSON.stringify(input.vaults?.length ? input.vaults : ['*']),
      secret,
      nowIso(),
    )
    return { id, url: input.url, events, vaults: input.vaults ?? ['*'], secret }
  }

  delete(id: string) {
    const r = this.db.run('DELETE FROM webhooks WHERE id = ?', id)
    if (!r.changes) throw notFound('Webhook')
    this.db.run('DELETE FROM webhook_deliveries WHERE webhook_id = ?', id)
  }

  private dispatch(e: BasaltEvent) {
    if (!EVENT_TYPES.includes(e.event)) return
    const hooks = this.db.all<any>('SELECT * FROM webhooks WHERE active = 1')
    for (const h of hooks) {
      const events = json<string[]>(h.events, [])
      const vaults = json<string[]>(h.vaults, [])
      if (!events.includes('*') && !events.includes(e.event)) continue
      if (!vaults.includes('*') && e.vault && !vaults.includes(e.vault)) continue
      const id = ulid()
      const body = JSON.stringify(e)
      this.db.run(
        'INSERT INTO webhook_deliveries (id, webhook_id, event, body, status, attempts, created, updated) VALUES (?,?,?,?,?,0,?,?)',
        id,
        h.id,
        e.event,
        body,
        'pending',
        nowIso(),
        nowIso(),
      )
      this.jobs.enqueue('webhook', e.vault, { delivery_id: id }, { maxAttempts: 6 })
    }
  }

  private async deliver(deliveryId: string, attempt: number) {
    const d = this.db.get<any>('SELECT d.*, w.url, w.secret FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.id = ?', deliveryId)
    if (!d) return
    let code: number | null = null
    try {
      const res = await fetch(d.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'BasaltNotes-Webhook/1',
          'x-basalt-event': d.event,
          'x-basalt-delivery': d.id,
          'x-basalt-signature': sign(d.secret, d.body),
        },
        body: d.body,
        signal: AbortSignal.timeout(10_000),
      })
      code = res.status
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      this.db.run("UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, response_code = ?, error = NULL, updated = ? WHERE id = ?", attempt, code, nowIso(), d.id)
    } catch (e) {
      const msg = (e as Error).message
      this.db.run('UPDATE webhook_deliveries SET status = ?, attempts = ?, response_code = ?, error = ?, updated = ? WHERE id = ?', attempt >= 6 ? 'failed' : 'retrying', attempt, code, msg, nowIso(), d.id)
      throw e
    }
  }
}
