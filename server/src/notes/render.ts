import MarkdownIt from 'markdown-it'
import sanitizeHtml from 'sanitize-html'
import { parseLinkInner, stripDmBlocks, stripBlockMarkers, parseNote } from './markdown.js'
import type { Vault } from './vault.js'

export interface RenderOptions {
  /** Vorlage für Links, z. B. "/wiki/{vault}/{id}" */
  linkBase?: string
  visibility?: 'dm' | 'players'
  /** URL-Präfix für Anhänge */
  attachmentBase?: string
  /** Tiefe für Einbettungen ![[Notiz]] */
  depth?: number
  /** Aufgaben-Checkboxen anklickbar machen (Leseansicht mit Schreibrecht) */
  interactiveTasks?: boolean
  /** Nur diese Notizen verlinken/einbetten (Zugänge mit Bereichs-Einschränkung) */
  allow?: (note: { campaign: string | null; path: string; type: string; visibility: string | null }) => boolean
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k) => encodeURIComponent(vars[k] ?? ''))
}

function slugHeading(h: string): string {
  return h
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}

const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags,
    'img',
    'del',
    's',
    'input',
    'details',
    'summary',
    'mark',
    'sup',
    'sub',
    'section',
    'h1',
    'h2',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'class', 'data-note-id', 'data-type', 'data-unresolved', 'data-heading', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    input: ['type', 'checked', 'disabled', 'data-task'],
    div: ['class', 'data-note-id'],
    section: ['class', 'data-note-id'],
    span: ['class'],
    code: ['class'],
    pre: ['class'],
    li: ['class'],
    ul: ['class'],
    h1: ['id'],
    h2: ['id'],
    h3: ['id'],
    h4: ['id'],
    h5: ['id'],
    h6: ['id'],
    th: ['style'],
    td: ['style'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  allowProtocolRelative: false,
  allowedStyles: { th: { 'text-align': [/^(left|right|center)$/] }, td: { 'text-align': [/^(left|right|center)$/] } },
  transformTags: {
    input: (tagName, attribs) => ({
      tagName,
      attribs: {
        type: 'checkbox',
        // Nur Aufgaben der Notiz selbst sind anklickbar (data-task = laufende Nummer), alles andere bleibt gesperrt
        ...(attribs['data-task'] !== undefined && /^\d+$/.test(attribs['data-task']) ? { 'data-task': attribs['data-task'] } : { disabled: 'disabled' }),
        ...(attribs.checked !== undefined ? { checked: 'checked' } : {}),
      },
    }),
  },
}

export class Renderer {
  constructor(private vault: Vault) {}

  private md(opts: RenderOptions, depth: number) {
    const md = new MarkdownIt({ html: true, linkify: true, breaks: false, typographer: false })
    const vault = this.vault
    const linkBase = opts.linkBase ?? '/{vault}/note/{id}'
    const attachmentBase = opts.attachmentBase ?? `/api/v1/vaults/${encodeURIComponent(vault.id)}/attachments/`

    md.inline.ruler.before('link', 'wikilink', (state, silent) => {
      const src = state.src
      let pos = state.pos
      const embed = src.charCodeAt(pos) === 0x21 /* ! */
      if (embed) pos++
      if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false
      const end = src.indexOf(']]', pos + 2)
      if (end < 0) return false
      const inner = src.slice(pos + 2, end)
      if (!inner || inner.includes('\n') || inner.includes('[')) return false
      if (!silent) {
        const token = state.push('wikilink', '', 0)
        token.meta = { inner, embed }
      }
      state.pos = end + 2
      return true
    })

    md.renderer.rules.wikilink = (tokens, idx) => {
      const { inner, embed } = tokens[idx].meta as { inner: string; embed: boolean }
      const { target, heading, display } = parseLinkInner(inner)
      if (embed && IMAGE_EXT.test(target)) {
        const src = attachmentBase + encodeURIComponent(target.replace(/^_attachments\//, ''))
        const width = display && /^\d+(x\d+)?$/.test(display) ? display.split('x')[0] : null
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(target)}" loading="lazy"${width ? ` width="${width}"` : ''}>`
      }
      // Andere Anhänge (PDF, Word, Audio …) → Link auf die Datei
      if (/\.[a-z0-9]{2,5}$/i.test(target) && !/\.md$/i.test(target) && vault.attachmentFile(target)) {
        const href = attachmentBase + encodeURIComponent(target.replace(/^_attachments\//, ''))
        return `<a class="attachment-link" href="${escapeHtml(href)}" target="_blank" rel="noopener">📄 ${escapeHtml(display ?? target)}</a>`
      }
      const text = display ?? (heading && !target ? heading : heading ? `${target} › ${heading}` : target)
      if (!target && heading) return `<a href="#${escapeHtml(slugHeading(heading))}" class="internal-link">${escapeHtml(text)}</a>`
      const id = vault.resolveName(target)
      const row = id ? vault.readNote(id) : null
      const hidden = !!row && ((opts.visibility === 'players' && row.visibility !== 'players') || (opts.allow ? !opts.allow(row) : false))
      if (!id || !row || hidden) {
        if (id && row && hidden) return `<span class="hidden-link">${escapeHtml(text)}</span>`
        return `<a class="internal-link unresolved" data-unresolved="${escapeHtml(target)}" href="#">${escapeHtml(text)}</a>`
      }
      if (embed && depth < (opts.depth ?? 1)) {
        const inner = this.renderBody(row.body, opts, depth + 1, heading)
        return `<div class="embed" data-note-id="${row.id}"><div class="embed-title"><a class="internal-link" href="${escapeHtml(fill(linkBase, { vault: vault.id, id: row.id, title: row.title }))}" data-note-id="${row.id}" data-type="${escapeHtml(row.type)}">${escapeHtml(row.title)}</a></div>${inner}</div>`
      }
      let href = fill(linkBase, { vault: vault.id, id: row.id, title: row.title })
      if (heading) href += `#${slugHeading(heading)}`
      return `<a class="internal-link" href="${escapeHtml(href)}" data-note-id="${row.id}" data-type="${escapeHtml(row.type)}"${heading ? ` data-heading="${escapeHtml(heading)}"` : ''}>${escapeHtml(text)}</a>`
    }

    // Überschriften-Anker
    md.renderer.rules.heading_open = (tokens, idx, options, _env, self) => {
      const inline = tokens[idx + 1]
      if (inline?.type === 'inline') tokens[idx].attrSet('id', slugHeading(inline.content))
      return self.renderToken(tokens, idx, options)
    }

    // Aufgaben-Checkboxen
    const interactive = !!opts.interactiveTasks && depth === 0
    let taskNo = 0
    md.core.ruler.after('inline', 'tasks', (state) => {
      const tokens = state.tokens
      for (let i = 2; i < tokens.length; i++) {
        const t = tokens[i]
        if (t.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue
        const m = /^\[([ xX])\]\s/.exec(t.content)
        if (!m || !t.children?.length) continue
        const first = t.children[0]
        if (first.type !== 'text') continue
        first.content = first.content.replace(/^\[([ xX])\]\s/, '')
        const cb = new state.Token('html_inline', '', 0)
        cb.content = `<input type="checkbox"${interactive ? ` data-task="${taskNo}"` : ' disabled'}${m[1] !== ' ' ? ' checked' : ''}> `
        taskNo++
        t.children.unshift(cb)
        tokens[i - 2].attrJoin('class', 'task-list-item')
      }
      return true
    })
    return md
  }

  renderBody(body: string, opts: RenderOptions = {}, depth = 0, section?: string | null): string {
    if (section || opts.visibility === 'players') opts = { ...opts, interactiveTasks: false }
    let text = opts.visibility === 'players' ? stripDmBlocks(body) : body
    if (section) {
      const re = new RegExp(`^(#{1,6})\\s+${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'mi')
      const m = re.exec(text)
      if (m) {
        const level = m[1].length
        const rest = text.slice(m.index + m[0].length)
        const next = new RegExp(`^#{1,${level}}\\s`, 'm').exec(rest)
        text = m[0] + (next ? rest.slice(0, next.index) : rest)
      }
    }
    text = stripBlockMarkers(text)
    const html = this.md(opts, depth).render(text)
    return sanitizeHtml(html, SANITIZE)
  }

  renderNote(raw: string, opts: RenderOptions = {}): string {
    return this.renderBody(parseNote(raw).body, opts)
  }
}

export function sanitize(html: string): string {
  return sanitizeHtml(html, SANITIZE)
}
