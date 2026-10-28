import { ulid } from 'ulid'
import { Db, json, nowIso } from './db.js'

export type JobHandler = (payload: any, job: { id: string; vault: string | null; attempts: number; signal: AbortSignal }) => Promise<void>

interface Lane {
  kinds: Set<string>
  busy: boolean
}

/**
 * Warteschlange im Prozess (SQLite-Tabelle `jobs`).
 * Zwei Spuren: „llm“ (Kurator, streng nacheinander) und „default“ (Webhooks, Neuindizierung).
 */
export class JobQueue {
  private handlers = new Map<string, JobHandler>()
  private lanes: Record<string, Lane> = { llm: { kinds: new Set(), busy: false }, default: { kinds: new Set(), busy: false } }
  private timer: NodeJS.Timeout | null = null
  private stopped = false
  /** Abbruch-Steuerung laufender Jobs */
  private controllers = new Map<string, AbortController>()

  constructor(private db: Db) {}

  register(kind: string, handler: JobHandler, lane: 'llm' | 'default' = 'default') {
    this.handlers.set(kind, handler)
    this.lanes[lane].kinds.add(kind)
  }

  enqueue(kind: string, vault: string | null, payload: any, opts: { delayMs?: number; maxAttempts?: number } = {}): string {
    const id = ulid()
    const now = nowIso()
    const runAfter = new Date(Date.now() + (opts.delayMs ?? 0)).toISOString()
    this.db.run(
      'INSERT INTO jobs (id, kind, vault, payload, status, attempts, max_attempts, run_after, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id,
      kind,
      vault,
      JSON.stringify(payload),
      'queued',
      0,
      opts.maxAttempts ?? 3,
      runAfter,
      now,
      now,
    )
    setImmediate(() => this.tick())
    return id
  }

  /**
   * Job abbrechen: wartende werden sofort verworfen, laufende bekommen ein Abbruchsignal.
   * Gibt zurück, in welchem Zustand der Job war.
   */
  cancel(jobId: string): 'running' | 'queued' | null {
    const ctrl = this.controllers.get(jobId)
    if (ctrl) {
      ctrl.abort()
      return 'running'
    }
    const r = this.db.run("UPDATE jobs SET status = 'cancelled', error = 'abgebrochen', updated = ? WHERE id = ? AND status = 'queued'", nowIso(), jobId)
    return r.changes ? 'queued' : null
  }

  /** Offene Jobs bestimmter Arten (optional nur eines Vaults) */
  pending(kinds: string[], vault?: string): { id: string; kind: string; status: string; payload: string }[] {
    return this.db.all(
      `SELECT id, kind, status, payload FROM jobs WHERE status IN ('queued','running') AND kind IN (${kinds.map(() => '?').join(',')})${vault ? ' AND vault = ?' : ''} ORDER BY created`,
      ...kinds,
      ...(vault ? [vault] : []),
    )
  }

  start() {
    this.db.run("UPDATE jobs SET status = 'queued' WHERE status = 'running'")
    this.stopped = false
    this.timer = setInterval(() => this.tick(), 1000)
  }

  async stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    for (let i = 0; i < 50 && Object.values(this.lanes).some((l) => l.busy); i++) await new Promise((r) => setTimeout(r, 100))
  }

  stats() {
    const rows = this.db.all<{ status: string; kind: string; n: number }>('SELECT status, kind, COUNT(*) n FROM jobs GROUP BY status, kind')
    const by: Record<string, number> = {}
    for (const r of rows) by[r.status] = (by[r.status] ?? 0) + r.n
    return { queued: by.queued ?? 0, running: by.running ?? 0, failed: by.failed ?? 0, done: by.done ?? 0, by_kind: rows }
  }

  /** Wartet, bis keine Jobs mehr anstehen (für Tests). */
  async drain(timeoutMs = 30_000) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      this.tick()
      const n = this.db.get<{ n: number }>("SELECT COUNT(*) n FROM jobs WHERE status IN ('queued','running') AND run_after <= ?", new Date().toISOString())?.n ?? 0
      if (!n && !Object.values(this.lanes).some((l) => l.busy)) return
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  private tick() {
    if (this.stopped) return
    for (const lane of Object.values(this.lanes)) {
      if (lane.busy || !lane.kinds.size) continue
      const kinds = [...lane.kinds]
      const job = this.db.get<any>(
        `SELECT * FROM jobs WHERE status = 'queued' AND run_after <= ? AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY run_after, created LIMIT 1`,
        new Date().toISOString(),
        ...kinds,
      )
      if (!job) continue
      lane.busy = true
      void this.runJob(job).finally(() => {
        lane.busy = false
        setImmediate(() => this.tick())
      })
    }
  }

  private async runJob(job: any) {
    const handler = this.handlers.get(job.kind)
    const attempts = job.attempts + 1
    this.db.run("UPDATE jobs SET status = 'running', attempts = ?, updated = ? WHERE id = ?", attempts, nowIso(), job.id)
    const ctrl = new AbortController()
    this.controllers.set(job.id, ctrl)
    try {
      if (!handler) throw new Error(`Kein Handler für ${job.kind}`)
      await handler(json(job.payload, {}), { id: job.id, vault: job.vault, attempts, signal: ctrl.signal })
      this.db.run("UPDATE jobs SET status = 'done', error = NULL, updated = ? WHERE id = ?", nowIso(), job.id)
    } catch (e) {
      if (ctrl.signal.aborted) {
        this.db.run("UPDATE jobs SET status = 'cancelled', error = 'abgebrochen', updated = ? WHERE id = ?", nowIso(), job.id)
        return
      }
      const msg = (e as Error).message ?? String(e)
      const retry = attempts < job.max_attempts && !(e as any).noRetry
      const delay = Math.min(30 * 60_000, 2 ** attempts * 5000)
      this.db.run(
        'UPDATE jobs SET status = ?, error = ?, run_after = ?, updated = ? WHERE id = ?',
        retry ? 'queued' : 'failed',
        msg,
        new Date(Date.now() + (retry ? delay : 0)).toISOString(),
        nowIso(),
        job.id,
      )
      if (!retry) console.error(`[jobs] ${job.kind} ${job.id} endgültig fehlgeschlagen: ${msg}`)
    } finally {
      this.controllers.delete(job.id)
    }
    // Alte erledigte Jobs aufräumen
    this.db.run("DELETE FROM jobs WHERE status = 'done' AND julianday(updated) < julianday('now', '-7 days')")
  }
}
