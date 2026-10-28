import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export function sha1(text: string): string {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex')
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

export function versionOf(raw: string): string {
  return `sha1:${sha1(raw)}`
}

export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64url')
}

/** Normalisiert Namen für den Abgleich (Groß-/Kleinschreibung egal, Unicode NFC). */
export function norm(text: string): string {
  return text.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ')
}

/** URL-/Ordner-taugliche Kurzform, z. B. "Fluch des Strahd" → "fluch-des-strahd" */
export function slugify(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Entfernt Zeichen, die in Dateinamen (Windows/SMB/Obsidian) Probleme machen. */
export function safeFileName(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
  return (cleaned || 'Unbenannt').slice(0, 150)
}

/** Umbenennen mit kurzen Wiederholungen (Windows sperrt frisch geschriebene Dateien gelegentlich: EBUSY/EPERM). */
export function renameRetry(from: string, to: string, tries = 8): void {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (i >= tries || !['EBUSY', 'EPERM', 'EACCES'].includes(code ?? '')) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (i + 1))
    }
  }
}

/** Atomares Schreiben: temporäre Datei + Umbenennen. */
export function writeFileAtomic(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(4).toString('hex')}.tmp`)
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, typeof content === 'string' ? Buffer.from(content, 'utf8') : content)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  renameRetry(tmp, file)
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}

/** Verhindert Pfade außerhalb des Basisordners. */
export function safeJoin(base: string, rel: string): string {
  const target = path.resolve(base, rel)
  const root = path.resolve(base)
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('Pfad außerhalb des Vaults')
  return target
}

export function encodeCursor(offset: number): string {
  return Buffer.from(String(offset)).toString('base64url')
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0
  const n = Number(Buffer.from(cursor, 'base64url').toString())
  return Number.isFinite(n) && n >= 0 ? n : 0
}

export function clampLimit(limit: unknown, def = 50, max = 500): number {
  const n = Number(limit)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.floor(n), max)
}

export function asArray(v: unknown): string[] {
  if (v === undefined || v === null || v === '') return []
  if (Array.isArray(v)) return v.map(String)
  return [String(v)]
}

/** Serialisiert Aufgaben (z. B. git, LLM) – immer nur eine gleichzeitig. */
export class Mutex {
  private last: Promise<unknown> = Promise.resolve()
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.last.then(fn, fn)
    this.last = next.catch(() => undefined)
    return next
  }
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
