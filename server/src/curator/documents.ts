import path from 'node:path'
import { extractText, getDocumentProxy } from 'unpdf'
import mammoth from 'mammoth'
import { invalid } from '../lib/errors.js'

export const DOCUMENT_TYPES: Record<string, string> = {
  '.pdf': 'PDF',
  '.docx': 'Word',
  '.txt': 'Text',
  '.md': 'Markdown',
  '.markdown': 'Markdown',
}

export interface ExtractedDocument {
  kind: string
  text: string
  pages: number | null
}

/** Silbentrennung am Zeilenende zusammenfügen, Leerraum aufräumen. */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Text aus PDF, Word, Text oder Markdown lesen. */
export async function extractDocument(filename: string, data: Buffer): Promise<ExtractedDocument> {
  const ext = path.extname(filename).toLowerCase()
  const kind = DOCUMENT_TYPES[ext]
  if (!kind) throw invalid(`Dateityp ${ext || '(ohne Endung)'} wird nicht unterstützt. Erlaubt: ${Object.keys(DOCUMENT_TYPES).join(', ')}`)

  if (ext === '.pdf') {
    let pages: string[]
    let total: number
    try {
      const pdf = await getDocumentProxy(new Uint8Array(data))
      const r = await extractText(pdf, { mergePages: false })
      pages = (r.text as string[]).map(tidy)
      total = r.totalPages
    } catch (e) {
      throw invalid(`PDF konnte nicht gelesen werden: ${(e as Error).message}`)
    }
    const chars = pages.reduce((n, p) => n + p.length, 0)
    if (chars < Math.max(40, total * 20)) {
      throw invalid('Das PDF enthält (fast) keinen Text – vermutlich eingescannte Seiten. Texterkennung (OCR) wird noch nicht unterstützt.')
    }
    // Seitenüberschriften helfen beim Aufteilen langer Dokumente und beim Wiederfinden
    const text = pages
      .map((p, i) => (p ? `## Seite ${i + 1}\n\n${p}` : ''))
      .filter(Boolean)
      .join('\n\n')
    return { kind, text, pages: total }
  }

  if (ext === '.docx') {
    try {
      const r = await mammoth.extractRawText({ buffer: data })
      const text = tidy(r.value)
      if (!text) throw new Error('kein Text gefunden')
      return { kind, text, pages: null }
    } catch (e) {
      throw invalid(`Word-Datei konnte nicht gelesen werden: ${(e as Error).message}`)
    }
  }

  const text = data.toString('utf8').replace(/^﻿/, '')
  if (!text.trim()) throw invalid('Die Datei ist leer.')
  return { kind, text: ext === '.txt' ? tidy(text) : text.trim(), pages: null }
}
