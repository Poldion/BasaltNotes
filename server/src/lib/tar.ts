import { gunzipSync } from 'node:zlib'
import { invalid } from './errors.js'

export interface TarFile {
  path: string
  data: Buffer
}

const BLOCK = 512
const MAX_UNPACKED = 200 * 1024 * 1024

const text = (b: Buffer, start: number, len: number) => {
  const raw = b.subarray(start, start + len)
  const end = raw.indexOf(0)
  return raw.subarray(0, end < 0 ? len : end).toString('utf8')
}

/** Pfad eines Archiv-Eintrags prüfen: nichts außerhalb des Zielordners */
function safePath(name: string): string {
  const clean = name.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '')
  if (clean.startsWith('/') || /^[a-zA-Z]:/.test(clean) || clean.split('/').some((seg) => seg === '..')) throw invalid(`Unzulässiger Pfad im Archiv: ${name}`)
  return clean
}

/**
 * .tar.gz im Speicher entpacken. Nur Dateien und Ordner sind erlaubt – Verknüpfungen und
 * Gerätedateien werden abgelehnt, damit ein Paket nichts außerhalb seines Ordners anfassen kann.
 */
export function readTarGz(gz: Buffer): TarFile[] {
  let tar: Buffer
  try {
    tar = gunzipSync(gz, { maxOutputLength: MAX_UNPACKED })
  } catch (e) {
    throw invalid(`Archiv lässt sich nicht entpacken: ${(e as Error).message}`)
  }
  const files: TarFile[] = []
  let longName: string | null = null
  let off = 0
  while (off + BLOCK <= tar.length) {
    const header = tar.subarray(off, off + BLOCK)
    if (header.every((x) => x === 0)) break
    const size = parseInt(text(header, 124, 12).trim() || '0', 8)
    if (!Number.isFinite(size) || size < 0) throw invalid('Beschädigtes Archiv.')
    const kind = String.fromCharCode(header[156] || 48)
    const prefix = text(header, 345, 155)
    const base = text(header, 0, 100)
    const name = longName ?? (prefix ? `${prefix}/${base}` : base)
    const start = off + BLOCK
    if (start + size > tar.length) throw invalid('Beschädigtes Archiv.')
    const body = tar.subarray(start, start + size)
    off = start + Math.ceil(size / BLOCK) * BLOCK
    if (kind === 'L') {
      longName = body.toString('utf8').replace(/\0+$/, '')
      continue
    }
    if (kind === 'x') {
      // Erweiterte Kopfzeilen: nur der lange Pfad ist hier wichtig
      const m = /(?:^|\n)\d+ path=([^\n]+)\n/.exec(body.toString('utf8'))
      if (m) longName = m[1]
      continue
    }
    longName = null
    if (kind === 'g' || kind === '5') continue
    if (kind !== '0' && kind !== '7') throw invalid(`Archiv enthält einen nicht erlaubten Eintrag: ${name}`)
    files.push({ path: safePath(name), data: Buffer.from(body) })
  }
  return files
}
