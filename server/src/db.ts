import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

export type Row = Record<string, any>

/** Dünner Wrapper um node:sqlite mit bequemen Helfern. */
export class Db {
  readonly raw: DatabaseSync
  private stmts = new Map<string, ReturnType<DatabaseSync['prepare']>>()

  constructor(file: string) {
    this.raw = new DatabaseSync(file)
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    this.migrate()
  }

  private prep(sql: string) {
    let s = this.stmts.get(sql)
    if (!s) {
      s = this.raw.prepare(sql)
      this.stmts.set(sql, s)
    }
    return s
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.prep(sql).all(...params) as T[]
  }

  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.prep(sql).get(...params) as T | undefined
  }

  run(sql: string, ...params: SQLInputValue[]) {
    return this.prep(sql).run(...params)
  }

  exec(sql: string) {
    this.raw.exec(sql)
  }

  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN')
    try {
      const r = fn()
      this.raw.exec('COMMIT')
      return r
    } catch (e) {
      this.raw.exec('ROLLBACK')
      throw e
    }
  }

  close() {
    this.raw.close()
  }

  private migrate() {
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

      -- Index (jederzeit aus den Dateien neu aufbaubar)
      CREATE TABLE IF NOT EXISTS notes (
        vault TEXT NOT NULL, id TEXT NOT NULL, path TEXT NOT NULL, type TEXT, title TEXT NOT NULL,
        campaign TEXT, visibility TEXT, frontmatter TEXT NOT NULL, body TEXT NOT NULL, version TEXT NOT NULL,
        created TEXT, updated TEXT, mtime REAL,
        PRIMARY KEY (vault, id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS notes_path ON notes(vault, path);
      CREATE INDEX IF NOT EXISTS notes_type ON notes(vault, type, campaign);
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        vault UNINDEXED, id UNINDEXED, title, aliases, body, body_public, tokenize = "unicode61 remove_diacritics 2"
      );
      CREATE TABLE IF NOT EXISTS names (
        vault TEXT NOT NULL, note_id TEXT NOT NULL, norm TEXT NOT NULL, display TEXT NOT NULL, kind TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS names_norm ON names(vault, norm);
      CREATE INDEX IF NOT EXISTS names_note ON names(vault, note_id);
      CREATE TABLE IF NOT EXISTS links (
        vault TEXT NOT NULL, source_id TEXT NOT NULL, target TEXT NOT NULL, target_norm TEXT NOT NULL,
        heading TEXT, display TEXT, embed INTEGER NOT NULL DEFAULT 0, line INTEGER, context TEXT, dm INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS links_source ON links(vault, source_id);
      CREATE INDEX IF NOT EXISTS links_target ON links(vault, target_norm);
      CREATE TABLE IF NOT EXISTS props (vault TEXT NOT NULL, note_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT);
      CREATE INDEX IF NOT EXISTS props_kv ON props(vault, key, value);
      CREATE INDEX IF NOT EXISTS props_note ON props(vault, note_id);
      CREATE TABLE IF NOT EXISTS tags (vault TEXT NOT NULL, note_id TEXT NOT NULL, tag TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tags_tag ON tags(vault, tag);
      CREATE INDEX IF NOT EXISTS tags_note ON tags(vault, note_id);
      CREATE TABLE IF NOT EXISTS blocks (
        vault TEXT NOT NULL, note_id TEXT NOT NULL, key TEXT NOT NULL, source_note TEXT, visibility TEXT, updated TEXT
      );
      CREATE INDEX IF NOT EXISTS blocks_key ON blocks(vault, key);
      CREATE INDEX IF NOT EXISTS blocks_note ON blocks(vault, note_id);

      -- Betriebsdaten
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, vault TEXT, payload TEXT NOT NULL, status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, run_after TEXT NOT NULL,
        error TEXT, created TEXT NOT NULL, updated TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(status, run_after);
      CREATE TABLE IF NOT EXISTS inbox (
        id TEXT PRIMARY KEY, vault TEXT NOT NULL, source_key TEXT, source TEXT, payload TEXT NOT NULL,
        curate TEXT NOT NULL, status TEXT NOT NULL, note_id TEXT, run_id TEXT, error TEXT, result TEXT,
        created TEXT NOT NULL, updated TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS inbox_vault ON inbox(vault, status, created);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, vault TEXT NOT NULL, source_key TEXT, inbox_id TEXT, note_id TEXT, campaign TEXT,
        mode TEXT NOT NULL, dry_run INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, input TEXT,
        extraction TEXT, plan TEXT, applied TEXT, commit_sha TEXT, error TEXT, llm TEXT,
        created TEXT NOT NULL, finished TEXT, reverted TEXT
      );
      CREATE INDEX IF NOT EXISTS runs_vault ON runs(vault, created);
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY, vault TEXT NOT NULL, run_id TEXT, campaign TEXT, note_id TEXT, op TEXT NOT NULL,
        kind TEXT NOT NULL, title TEXT, reason TEXT, confidence REAL, status TEXT NOT NULL,
        created TEXT NOT NULL, resolved TEXT
      );
      CREATE INDEX IF NOT EXISTS proposals_vault ON proposals(vault, status, created);
      CREATE TABLE IF NOT EXISTS tokens (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, vaults TEXT NOT NULL, scopes TEXT NOT NULL,
        visibility TEXT, campaign TEXT, kind TEXT NOT NULL DEFAULT 'api', created TEXT NOT NULL, expires TEXT, last_used TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, username TEXT NOT NULL, user_id TEXT, csrf TEXT NOT NULL, created TEXT NOT NULL, expires TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT, password_hash TEXT,
        role TEXT NOT NULL, vaults TEXT NOT NULL DEFAULT '"*"', campaign TEXT, disabled INTEGER NOT NULL DEFAULT 0,
        created TEXT NOT NULL, updated TEXT NOT NULL, last_login TEXT
      );
      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT NOT NULL, scope TEXT NOT NULL, status INTEGER NOT NULL, body TEXT NOT NULL, headers TEXT, created TEXT NOT NULL,
        PRIMARY KEY (key, scope)
      );
      CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY, url TEXT NOT NULL, events TEXT NOT NULL, vaults TEXT NOT NULL, secret TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL, event TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, response_code INTEGER, error TEXT, created TEXT NOT NULL, updated TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS deliveries_hook ON webhook_deliveries(webhook_id, created);
    `)
    // Ältere Datenbanken: Index-Tabellen mit neuen Spalten neu anlegen (werden beim Öffnen der Vaults neu befüllt)
    const fts = this.raw.prepare('PRAGMA table_info(notes_fts)').all() as { name: string }[]
    if (!fts.some((c) => c.name === 'body_public')) {
      this.raw.exec(`DROP TABLE notes_fts; CREATE VIRTUAL TABLE notes_fts USING fts5(
        vault UNINDEXED, id UNINDEXED, title, aliases, body, body_public, tokenize = "unicode61 remove_diacritics 2");`)
    }
    const linkCols = this.raw.prepare('PRAGMA table_info(links)').all() as { name: string }[]
    if (!linkCols.some((c) => c.name === 'dm')) this.raw.exec('ALTER TABLE links ADD COLUMN dm INTEGER NOT NULL DEFAULT 0')
    // Ältere Datenbanken: Spalte user_id in sessions nachrüsten
    const cols = this.raw.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'user_id')) this.raw.exec('ALTER TABLE sessions ADD COLUMN user_id TEXT; DELETE FROM sessions;')
    const tokenCols = this.raw.prepare('PRAGMA table_info(tokens)').all() as { name: string }[]
    if (!tokenCols.some((c) => c.name === 'grants')) this.raw.exec('ALTER TABLE tokens ADD COLUMN grants TEXT')
  }
}

export function nowIso(): string {
  return isoWithOffset(new Date())
}

/** ISO-8601 mit lokaler Zeitzone, z. B. 2026-10-12T01:40:00+02:00 */
export function isoWithOffset(d: Date): string {
  const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(off / 60)}:${pad(off % 60)}`
  )
}

export function json<T = any>(value: string | null | undefined, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
