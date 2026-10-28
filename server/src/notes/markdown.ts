import YAML from 'yaml'

export interface ParsedNote {
  /** Frontmatter als Objekt (leer, wenn keines vorhanden). */
  frontmatter: Record<string, any>
  /** YAML-Text des Frontmatters (ohne ---), null wenn keines vorhanden. */
  fmText: string | null
  /** Alles nach dem Frontmatter, byte-genau. */
  body: string
}

const FM_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/

export function parseNote(raw: string): ParsedNote {
  const text = raw.startsWith('﻿') ? raw.slice(1) : raw
  const m = FM_RE.exec(text)
  if (!m) return { frontmatter: {}, fmText: null, body: text }
  let fm: Record<string, any> = {}
  try {
    const parsed = YAML.parse(m[1])
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fm = parsed
  } catch {
    // ungültiges YAML: als leer behandeln, Text bleibt erhalten
  }
  return { frontmatter: fm, fmText: m[1], body: text.slice(m[0].length) }
}

/** Setzt Frontmatter-Werte und behält Kommentare/Reihenfolge des bestehenden YAML bei. */
export function mergeFrontmatterText(fmText: string | null, changes: Record<string, any>, remove: string[] = []): string {
  const doc = fmText !== null ? YAML.parseDocument(fmText) : new YAML.Document({})
  if (!doc.contents || !YAML.isMap(doc.contents)) doc.contents = doc.createNode({}) as any
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined) continue
    doc.set(k, v)
  }
  for (const k of remove) doc.delete(k)
  return doc.toString({ lineWidth: 0 }).replace(/\n$/, '')
}

export function stringifyFrontmatter(fm: Record<string, any>): string {
  return YAML.stringify(fm, { lineWidth: 0 }).replace(/\n$/, '')
}

export function composeNote(fmText: string | null, body: string): string {
  if (fmText === null || fmText.trim() === '' || fmText.trim() === '{}') return body
  return `---\n${fmText}\n---\n${body}`
}

// ---------------------------------------------------------------- Links

export interface WikiLink {
  raw: string
  target: string
  heading: string | null
  display: string | null
  embed: boolean
  index: number
  line: number
}

const LINK_RE = /(!?)\[\[([^\[\]\n]+?)\]\]/g

/** Ersetzt Code-Bereiche durch Leerzeichen gleicher Länge, damit Positionen stimmen. */
export function maskCode(body: string): string {
  let out = body.replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(\n\2[^\n]*(?=\n|$)|$)/g, (m) => m.replace(/[^\n]/g, ' '))
  out = out.replace(/`[^`\n]+`/g, (m) => ' '.repeat(m.length))
  out = out.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
  return out
}

export function parseLinkInner(inner: string): { target: string; heading: string | null; display: string | null } {
  let target = inner
  let display: string | null = null
  const pipe = target.indexOf('|')
  if (pipe >= 0) {
    display = target.slice(pipe + 1).trim() || null
    target = target.slice(0, pipe)
  }
  let heading: string | null = null
  const hash = target.indexOf('#')
  if (hash >= 0) {
    heading = target.slice(hash + 1).trim() || null
    target = target.slice(0, hash)
  }
  return { target: target.trim(), heading, display }
}

export function extractLinks(body: string): WikiLink[] {
  const masked = maskCode(body)
  const links: WikiLink[] = []
  LINK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = LINK_RE.exec(masked))) {
    const raw = body.slice(m.index, m.index + m[0].length)
    const inner = raw.slice(m[1].length + 2, -2)
    const { target, heading, display } = parseLinkInner(inner)
    if (!target && !heading) continue
    links.push({
      raw,
      target,
      heading,
      display,
      embed: m[1] === '!',
      index: m.index,
      line: body.slice(0, m.index).split('\n').length,
    })
  }
  return links
}

/** Kontext-Ausschnitt rund um eine Position (für Backlinks). */
export function contextAround(body: string, index: number, radius = 80): string {
  const lineStart = body.lastIndexOf('\n', index) + 1
  let lineEnd = body.indexOf('\n', index)
  if (lineEnd < 0) lineEnd = body.length
  let start = Math.max(lineStart, index - radius)
  let end = Math.min(lineEnd, index + radius)
  let s = body.slice(start, end).trim()
  if (start > lineStart) s = '…' + s
  if (end < lineEnd) s = s + '…'
  return s.replace(/<!--[\s\S]*?-->/g, '').trim()
}

/**
 * Ersetzt Links auf ein Ziel. `matches` entscheidet anhand des Linkziels, ob ersetzt wird.
 * Überschrift und Anzeigetext bleiben erhalten; alles andere bleibt byte-genau.
 */
export function replaceLinks(body: string, matches: (target: string) => boolean, newTarget: string): { body: string; count: number } {
  const links = extractLinks(body)
  let out = ''
  let last = 0
  let count = 0
  for (const l of links) {
    if (!l.target || !matches(l.target)) continue
    let inner = newTarget
    if (l.heading) inner += `#${l.heading}`
    if (l.display) inner += `|${l.display}`
    out += body.slice(last, l.index) + `${l.embed ? '!' : ''}[[${inner}]]`
    last = l.index + l.raw.length
    count++
  }
  return { body: out + body.slice(last), count }
}

export function extractTags(body: string): string[] {
  const masked = maskCode(body).replace(LINK_RE, ' ')
  const tags = new Set<string>()
  const re = /(^|[\s(])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu
  let m: RegExpExecArray | null
  while ((m = re.exec(masked))) {
    // Überschriften ("# Titel") ausschließen: dort folgt ein Leerzeichen, das matcht hier nicht
    tags.add(m[2])
  }
  return [...tags]
}

export function headings(body: string): { level: number; text: string; index: number }[] {
  const masked = maskCode(body)
  const out: { level: number; text: string; index: number }[] = []
  const re = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(masked))) out.push({ level: m[1].length, text: body.slice(m.index + m[1].length, m.index + m[0].length).trim().replace(/[ \t#]*$/, ''), index: m.index })
  return out
}

// ---------------------------------------------------------------- Verwaltete Bereiche

export interface BlockInfo {
  key: string
  attrs: Record<string, string>
  content: string
  start: number
  end: number
  contentStart: number
  contentEnd: number
}

const BLOCK_START_RE = /<!--\s*basalt:block\b([^>]*?)-->/g
const BLOCK_END = '<!-- /basalt:block -->'
const BLOCK_END_RE = /<!--\s*\/basalt:block\s*-->/g

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([\w-]+)="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) attrs[m[1]] = m[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  return attrs
}

function escAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/-->/g, '-- >')
}

export function listBlocks(body: string): BlockInfo[] {
  const blocks: BlockInfo[] = []
  BLOCK_START_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = BLOCK_START_RE.exec(body))) {
    const attrs = parseAttrs(m[1])
    BLOCK_END_RE.lastIndex = m.index + m[0].length
    const e = BLOCK_END_RE.exec(body)
    if (!e) break
    let contentStart = m.index + m[0].length
    if (body[contentStart] === '\r') contentStart++
    if (body[contentStart] === '\n') contentStart++
    let contentEnd = e.index
    if (body[contentEnd - 1] === '\n') contentEnd--
    if (body[contentEnd - 1] === '\r') contentEnd--
    if (contentEnd < contentStart) contentEnd = contentStart
    blocks.push({
      key: attrs.key ?? '',
      attrs,
      content: body.slice(contentStart, contentEnd),
      start: m.index,
      end: e.index + e[0].length,
      contentStart,
      contentEnd,
    })
    BLOCK_START_RE.lastIndex = e.index + e[0].length
  }
  return blocks
}

export interface BlockInput {
  key: string
  content: string
  heading?: string | null
  source?: string | null
  visibility?: string | null
  updated?: string
}

export function renderBlock(b: BlockInput): string {
  const attrs = [`key="${escAttr(b.key)}"`]
  if (b.source) attrs.push(`source="${escAttr(b.source)}"`)
  if (b.visibility) attrs.push(`visibility="${escAttr(b.visibility)}"`)
  if (b.updated) attrs.push(`updated="${escAttr(b.updated)}"`)
  const content = b.content.replace(/\s+$/, '')
  return `<!-- basalt:block ${attrs.join(' ')} -->\n${content}${content ? '\n' : ''}${BLOCK_END}`
}

/**
 * Setzt einen Bereich: gleicher Key → ersetzen, neuer Key → anhängen (unter `heading`, sonst am Ende).
 * Text außerhalb des Bereichs bleibt byte-genau erhalten (es wird nur eingefügt bzw. der Bereich selbst ersetzt).
 */
export function setBlock(body: string, input: BlockInput): string {
  const rendered = renderBlock(input)
  const existing = listBlocks(body).find((b) => b.key === input.key)
  if (existing) return body.slice(0, existing.start) + rendered + body.slice(existing.end)

  if (input.heading) {
    const hs = headings(body)
    const idx = hs.findIndex((h) => h.text.toLowerCase() === input.heading!.toLowerCase())
    if (idx >= 0) {
      const h = hs[idx]
      const next = hs.slice(idx + 1).find((x) => x.level <= h.level)
      const sectionEnd = next ? next.index : body.length
      // nach dem letzten Inhalt des Abschnitts einfügen
      let pos = sectionEnd
      while (pos > h.index && /\s/.test(body[pos - 1])) pos--
      const headingLineEnd = body.indexOf('\n', h.index)
      if (headingLineEnd >= 0 && pos < headingLineEnd) pos = headingLineEnd
      const tail = body.slice(pos)
      return body.slice(0, pos) + '\n' + rendered + (tail === '' ? '\n' : tail)
    }
    const prefix = body === '' ? '' : body.endsWith('\n\n') ? '' : body.endsWith('\n') ? '\n' : '\n\n'
    return `${body}${prefix}## ${input.heading}\n${rendered}\n`
  }
  const prefix = body === '' ? '' : body.endsWith('\n\n') ? '' : body.endsWith('\n') ? '\n' : '\n\n'
  return `${body}${prefix}${rendered}\n`
}

export function removeBlock(body: string, key: string): { body: string; removed: boolean } {
  const b = listBlocks(body).find((x) => x.key === key)
  if (!b) return { body, removed: false }
  let end = b.end
  if (body[end] === '\r') end++
  if (body[end] === '\n') end++
  return { body: body.slice(0, b.start) + body.slice(end), removed: true }
}

/** Entfernt Bereiche mit `visibility="dm"` (für die Spieler-Sicht). */
export function stripDmBlocks(body: string): string {
  let out = body
  for (const b of listBlocks(body).reverse()) {
    if ((b.attrs.visibility ?? '') === 'dm') out = out.slice(0, b.start) + out.slice(b.end)
  }
  return out
}

/** Entfernt Bereichs-Markierungen, lässt den Inhalt stehen (z. B. für Kurzfassungen). */
export function stripBlockMarkers(body: string): string {
  return body.replace(BLOCK_START_RE, '').replace(BLOCK_END_RE, '')
}

/** Aufgabe in einer Liste: „- [ ] Text“ (auch nummeriert oder in Zitaten), wie markdown-it sie erkennt */
const TASK_RE = /^((?:[ \t]*>)*[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])(\][ \t]+)(\S.*)$/gm

export interface TaskItem {
  index: number
  checked: boolean
  text: string
  /** Position des Häkchen-Zeichens im Text */
  offset: number
  line: number
}

/** Alle Aufgaben eines Notiztexts in Dokument-Reihenfolge (Code-Blöcke zählen nicht) */
export function listTasks(body: string): TaskItem[] {
  const masked = maskCode(body)
  const out: TaskItem[] = []
  for (const m of masked.matchAll(TASK_RE)) {
    const offset = m.index! + m[1].length
    out.push({ index: out.length, checked: m[2] !== ' ', text: body.slice(offset + 1 + m[3].length, m.index! + m[0].length).trim(), offset, line: masked.slice(0, m.index).split('\n').length - 1 })
  }
  return out
}

/** Aufgabe Nr. index abhaken/zurücksetzen – ändert genau ein Zeichen */
export function setTask(body: string, index: number, checked: boolean): string {
  const t = listTasks(body)[index]
  if (!t) throw new Error('Aufgabe nicht gefunden')
  return body.slice(0, t.offset) + (checked ? 'x' : ' ') + body.slice(t.offset + 1)
}

/** Neuen Listenpunkt hinter den letzten Punkt der Liste setzen (gleiche Einrückung/Aufzählung), sonst ans Ende */
export function appendTask(body: string, text: string, checked = false): string {
  const lines = body.split('\n')
  const last = listTasks(body).at(-1)
  const clean = text.replace(/\r?\n/g, ' ').trim()
  if (last) {
    const marker = /^(\s*(?:[-*+]|\d+[.)])[ \t]+)/.exec(lines[last.line])?.[1] ?? '- '
    lines.splice(last.line + 1, 0, `${marker.replace(/\d+([.)])/, '1$1')}[${checked ? 'x' : ' '}] ${clean}`)
    return lines.join('\n')
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  return [...lines, ...(lines.length ? [''] : []), `- [${checked ? 'x' : ' '}] ${clean}`, ''].join('\n')
}
