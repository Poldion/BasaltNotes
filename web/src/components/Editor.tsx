import { useEffect, useRef } from 'react'
import { EditorSelection, EditorState, RangeSetBuilder, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, placeholder as cmPlaceholder, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { autocompletion, closeBrackets, completionKeymap, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { tags as t } from '@lezer/highlight'
import { api, enc } from '../lib/api'
import { lang, tr } from '../lib/i18n'

// ------------------------------------------------------------ Namen für Autovervollständigung (Cache je Vault)

interface NameItem {
  id: string
  title: string
  type: string
  aliases: string[]
}
const nameCache = new Map<string, { at: number; items: NameItem[]; set: Set<string> }>()

export async function loadNames(vault: string, force = false) {
  const c = nameCache.get(vault)
  if (c && !force && Date.now() - c.at < 30_000) return c
  const r = await api<{ items: NameItem[] }>(`/vaults/${enc(vault)}/notes?fields=title,type,aliases,path&limit=500&sort=title`)
  const set = new Set<string>()
  for (const it of r.items) {
    set.add(it.title.toLowerCase())
    for (const a of it.aliases ?? []) set.add(String(a).toLowerCase())
    const p = (it as any).path as string | undefined
    if (p) {
      set.add(p.replace(/\.md$/i, '').toLowerCase())
      set.add(p.replace(/\.md$/i, '').split('/').pop()!.toLowerCase())
    }
  }
  const entry = { at: Date.now(), items: r.items, set }
  nameCache.set(vault, entry)
  return entry
}

export function invalidateNames(vault: string) {
  nameCache.delete(vault)
}

function wikiCompletion(vault: string) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const m = ctx.matchBefore(/\[\[[^\]\[|#\n]*$/)
    if (!m) return null
    const { items } = await loadNames(vault)
    const after = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2)
    const close = after === ']]' ? '' : ']]'
    const options = []
    for (const it of items) {
      options.push({ label: it.title, detail: it.type, apply: it.title + close, boost: 1 })
      for (const a of it.aliases ?? []) options.push({ label: String(a), detail: `→ ${it.title}`, apply: `${it.title}|${a}${close}`, boost: 0 })
    }
    return { from: m.from + 2, options, validFor: /^[^\]\[|#\n]*$/, filter: true }
  }
}

// ------------------------------------------------------------ Darstellung

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.6em', fontWeight: '700' },
  { tag: t.heading2, fontSize: '1.35em', fontWeight: '700' },
  { tag: t.heading3, fontSize: '1.15em', fontWeight: '650' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '650' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--link)' },
  { tag: t.url, color: 'var(--muted)' },
  { tag: t.quote, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)', fontSize: '0.9em', backgroundColor: 'var(--surface-2)' },
  { tag: [t.processingInstruction, t.meta], color: 'var(--faint)' },
  { tag: t.comment, color: 'var(--faint)' },
  { tag: t.list, color: 'var(--accent)' },
  { tag: t.contentSeparator, color: 'var(--faint)' },
  { tag: t.keyword, color: 'var(--dm)' },
  { tag: t.string, color: 'var(--ok)' },
  { tag: t.number, color: 'var(--warn)' },
  { tag: t.atom, color: 'var(--accent)' },
])

class BadgeWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly dm: boolean,
  ) {
    super()
  }
  eq(o: BadgeWidget) {
    return o.text === this.text && o.dm === this.dm
  }
  toDOM() {
    const s = document.createElement('span')
    s.className = `cm-block-badge${this.dm ? ' dm' : ''}`
    s.textContent = this.text
    s.title = tr('Verwalteter Bereich – wird von Maschinen geschrieben. Eigener Text gehört außerhalb.')
    return s
  }
}

const LINK_RE = /(!?)\[\[([^\[\]\n]+?)\]\]/g
const START_RE = /^\s*<!--\s*basalt:block\b([^>]*?)-->\s*$/
const END_RE = /^\s*<!--\s*\/basalt:block\s*-->\s*$/

function attr(s: string, name: string): string | null {
  const m = new RegExp(`${name}="([^"]*)"`).exec(s)
  return m ? m[1] : null
}

/** Live-Vorschau: Wiki-Links hervorheben, Bereichs-Markierungen als Abzeichen (außer in der Cursorzeile). */
function livePreview(getKnown: () => Set<string> | null) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = this.build(view)
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || u.transactions.some((tr) => tr.effects.length)) this.decorations = this.build(u.view)
      }
      build(view: EditorView): DecorationSet {
        const b = new RangeSetBuilder<Decoration>()
        const doc = view.state.doc
        const sel = view.state.selection.main
        const cursorLines = new Set<number>()
        for (let l = doc.lineAt(sel.from).number; l <= doc.lineAt(sel.to).number; l++) cursorLines.add(l)
        const known = getKnown()
        // Bereiche: Zustand vom Dokumentanfang bis zum sichtbaren Bereich bestimmen
        const first = doc.lineAt(view.viewport.from).number
        const last = doc.lineAt(view.viewport.to).number
        let inBlock: { dm: boolean } | null = null
        for (let n = 1; n < first; n++) {
          const text = doc.line(n).text
          if (START_RE.test(text)) inBlock = { dm: /visibility="dm"/.test(text) }
          else if (END_RE.test(text)) inBlock = null
        }
        for (let n = first; n <= last; n++) {
          const line = doc.line(n)
          const text = line.text
          const sm = START_RE.exec(text)
          if (sm) {
            const dm = attr(sm[1], 'visibility') === 'dm'
            inBlock = { dm }
            if (!cursorLines.has(n)) {
              const key = attr(sm[1], 'key') ?? ''
              const src = attr(sm[1], 'source')
              b.add(line.from, line.to, Decoration.replace({ widget: new BadgeWidget(`⚙ ${src ? `aus ${src.replace(/^\[\[|\]\]$/g, '')}` : key}${dm ? tr(' · nur DM') : ''}`, dm) }))
            }
            continue
          }
          if (END_RE.test(text)) {
            if (!cursorLines.has(n)) b.add(line.from, line.to, Decoration.replace({ widget: new BadgeWidget(tr('⚙ Ende'), !!inBlock?.dm) }))
            inBlock = null
            continue
          }
          if (inBlock) b.add(line.from, line.from, Decoration.line({ class: `cm-block-line${inBlock.dm ? ' dm' : ''}` }))
          LINK_RE.lastIndex = 0
          let m: RegExpExecArray | null
          while ((m = LINK_RE.exec(text))) {
            const start = line.from + m.index
            const open = m[1].length + 2
            const inner = m[2]
            const target = inner.split('|')[0].split('#')[0].trim().toLowerCase()
            const unresolved = known && target && !known.has(target) && !/\.(png|jpe?g|gif|webp|svg|pdf)$/i.test(target)
            b.add(start, start + open, Decoration.mark({ class: 'cm-wikilink-bracket' }))
            b.add(start + open, start + open + inner.length, Decoration.mark({ class: `cm-wikilink${unresolved ? ' unresolved' : ''}`, attributes: { 'data-target': inner } }))
            b.add(start + open + inner.length, start + m[0].length, Decoration.mark({ class: 'cm-wikilink-bracket' }))
          }
        }
        return b.finish()
      }
    },
    { decorations: (v) => v.decorations },
  )
}

function wrap(view: EditorView, before: string, after = before) {
  view.dispatch(
    view.state.changeByRange((r) => ({
      changes: [
        { from: r.from, insert: before },
        { from: r.to, insert: after },
      ],
      range: EditorSelection.range(r.from + before.length, r.to + before.length),
    })),
  )
  return true
}

// ------------------------------------------------------------ Komponente

export interface EditorProps {
  vault: string
  value: string
  onChange: (v: string) => void
  onSave?: () => void
  onOpenLink?: (target: string) => void
  raw?: boolean
  readOnly?: boolean
  placeholder?: string
}

export function Editor({ vault, value, onChange, onSave, onOpenLink, raw, readOnly, placeholder }: EditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const cb = useRef({ onChange, onSave, onOpenLink })
  cb.current = { onChange, onSave, onOpenLink }
  const known = useRef<Set<string> | null>(null)

  useEffect(() => {
    let alive = true
    loadNames(vault)
      .then((n) => {
        if (!alive) return
        known.current = n.set
        view.current?.dispatch({ effects: [] })
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [vault])

  useEffect(() => {
    if (!host.current) return
    const upload = async (files: FileList | File[], pos: number, v: EditorView) => {
      for (const f of Array.from(files)) {
        const fd = new FormData()
        fd.append('file', f, f.name || `bild-${Date.now()}.png`)
        try {
          const r = await api<{ embed: string }>(`/vaults/${enc(vault)}/attachments`, { body: fd })
          v.dispatch({ changes: { from: pos, insert: `${r.embed}\n` } })
          pos += r.embed.length + 1
        } catch (e) {
          alert(tr('Upload fehlgeschlagen: {message}', { message: (e as Error).message }))
        }
      }
    }
    const extensions: Extension[] = [
      history(),
      search({ top: true }),
      highlightSelectionMatches(),
      closeBrackets(),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      syntaxHighlighting(highlight),
      autocompletion({ override: [wikiCompletion(vault)], icons: false }),
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => (cb.current.onSave?.(), true) },
        { key: 'Mod-b', run: (v) => wrap(v, '**') },
        { key: 'Mod-i', run: (v) => wrap(v, '*') },
        { key: 'Mod-k', run: (v) => wrap(v, '[[', ']]') },
        ...completionKeymap,
        ...searchKeymap,
        ...historyKeymap,
        indentWithTab,
        ...defaultKeymap,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) cb.current.onChange(u.state.doc.toString())
      }),
      EditorView.domEventHandlers({
        mousedown: (e) => {
          const el = (e.target as HTMLElement).closest('.cm-wikilink') as HTMLElement | null
          if (el && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            const target = el.dataset.target ?? el.textContent ?? ''
            cb.current.onOpenLink?.(target)
            return true
          }
          return false
        },
        paste: (e, v) => {
          const files = e.clipboardData?.files
          if (files && files.length) {
            e.preventDefault()
            void upload(files, v.state.selection.main.head, v)
            return true
          }
          return false
        },
        drop: (e, v) => {
          const files = e.dataTransfer?.files
          if (files && files.length) {
            e.preventDefault()
            const pos = v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? v.state.selection.main.head
            void upload(files, pos, v)
            return true
          }
          return false
        },
      }),
      EditorView.contentAttributes.of({ 'aria-label': tr('Notiztext'), spellcheck: 'true', lang }),
      EditorState.readOnly.of(!!readOnly),
    ]
    if (!raw) extensions.push(livePreview(() => known.current))
    if (placeholder) extensions.push(cmPlaceholder(placeholder))
    const v = new EditorView({ state: EditorState.create({ doc: value, extensions }), parent: host.current })
    view.current = v
    return () => {
      v.destroy()
      view.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault, raw, readOnly])

  // Externe Änderungen übernehmen (z. B. nach Neuladen)
  useEffect(() => {
    const v = view.current
    if (!v) return
    const cur = v.state.doc.toString()
    if (cur !== value) v.dispatch({ changes: { from: 0, to: cur.length, insert: value } })
  }, [value])

  return <div ref={host} className={`editor-wrap ${raw ? 'raw' : ''}`} />
}
