import { Fragment, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { enc } from './api'

export interface AnswerSource {
  id: string
  title: string
  type: string
  role: string
  aliases?: string[]
  headings?: string[]
}

const fold = (s: string) =>
  s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/** Wie die Überschriften-IDs im gerenderten Markdown (server/src/notes/render.ts) */
export function slugHeading(h: string): string {
  return h
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}

const hasWords = (hay: string, needle: string) => ` ${hay} `.includes(` ${needle} `)

/**
 * Verweis aus der Antwort einer Quelle zuordnen. Kleine Modelle schreiben selten genau den Titel:
 * „[Lythenia (Charakter)]“, „[Charakterbogen: Lythenia Sylmir]“, „[Hintergrundgeschichte]“ (ein Abschnitt) …
 */
export function resolveRef(raw: string, sources: AnswerSource[]): { source: AnswerSource; heading?: string } | null {
  const full = fold(raw)
  if (!full) return null
  const noSuffix = fold(raw.replace(/\s*\([^)]*\)\s*$/, ''))
  const parts = raw
    .split(/[:,;/–—›>]| - /)
    .map((p) => fold(p.replace(/\([^)]*\)/g, '')))
    .filter(Boolean)
  const cands = [...new Set([full, noSuffix, ...parts])]
  const ordered = [...sources].sort((a, b) => Number(b.role === 'focus') - Number(a.role === 'focus'))
  const namesOf = (s: AnswerSource) => [s.title, ...(s.aliases ?? [])].map(fold).filter(Boolean)
  const headingIn = (s: AnswerSource) => (s.headings ?? []).find((h) => cands.includes(fold(h)))

  // 1. Name genau (ganz, ohne Zusatz in Klammern oder als Teil „Typ: Name“)
  for (const s of ordered) if (namesOf(s).some((n) => cands.includes(n))) return { source: s, heading: headingIn(s) }
  // 2. Abschnitt eines Eintrags („[Hintergrundgeschichte]“)
  for (const s of ordered) {
    const h = headingIn(s)
    if (h) return { source: s, heading: h }
  }
  // 3. Name steckt im Verweis („[Lythenia, die Waldläuferin]“) – längster Name gewinnt
  let best: { s: AnswerSource; len: number } | null = null
  for (const s of ordered) for (const n of namesOf(s)) if (n.length >= 4 && hasWords(full, n) && (!best || n.length > best.len)) best = { s, len: n.length }
  if (best) return { source: best.s }
  // 4. Verweis ist der Anfang eines Namens („[Lythenia]“ für „Lythenia Sylmir“)
  if (noSuffix.length >= 4) for (const s of ordered) if (namesOf(s).some((n) => n.startsWith(noSuffix + ' '))) return { source: s }
  return null
}

/** Inline: **fett**, *kursiv*, `code`, [Verweis] */
function inline(text: string, sources: AnswerSource[], vault: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\s][^*\n]*\*|`[^`\n]+`|\[[^\]\n]{1,120}\])/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const t = m[0]
    const k = `${key}-${i++}`
    if (t.startsWith('**') || t.startsWith('__')) out.push(<strong key={k}>{inline(t.slice(2, -2), sources, vault, k)}</strong>)
    else if (t.startsWith('`')) out.push(<code key={k}>{t.slice(1, -1)}</code>)
    else if (t.startsWith('*')) out.push(<em key={k}>{inline(t.slice(1, -1), sources, vault, k)}</em>)
    else {
      const inner = t.slice(1, -1).replace(/^\[|\]$/g, '').trim()
      const ref = resolveRef(inner, sources)
      if (ref) {
        const href = `/${vault}/note/${enc(ref.source.id)}${ref.heading ? `#${slugHeading(ref.heading)}` : ''}`
        out.push(
          <Link key={k} to={href} className="chat-ref" title={ref.heading ? `${ref.source.title} › ${ref.heading}` : ref.source.title}>
            {ref.heading && !fold(inner).includes(fold(ref.source.title)) ? `${ref.source.title} › ${ref.heading}` : inner.replace(/\s*\([^)]*\)\s*$/, '') || ref.source.title}
          </Link>,
        )
      } else {
        out.push(
          <span key={k} className="chat-ref unresolved">
            {inner}
          </span>,
        )
      }
    }
    last = m.index + t.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** Antwort des Modells mit einfachem Markdown (Absätze, Listen, Überschriften) und verlinkten Verweisen */
export function AnswerText({ text, sources, vault }: { text: string; sources: AnswerSource[]; vault: string }) {
  const blocks: ReactNode[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let para: string[] = []
  const flushPara = () => {
    if (para.length) {
      const k = `p${blocks.length}`
      blocks.push(
        <p key={k}>
          {para.map((l, i) => (
            <Fragment key={i}>
              {i > 0 && <br />}
              {inline(l, sources, vault, `${k}-${i}`)}
            </Fragment>
          ))}
        </p>,
      )
      para = []
    }
  }
  const flushList = () => {
    if (list) {
      const k = `l${blocks.length}`
      const items = list.items.map((it, i) => <li key={i}>{inline(it, sources, vault, `${k}-${i}`)}</li>)
      blocks.push(list.ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>)
      list = null
    }
  }
  for (const line of text.split('\n')) {
    const li = /^\s*([*\-+•]|\d+[.)])\s+(.*)$/.exec(line)
    const h = /^\s*#{1,6}\s+(.*)$/.exec(line)
    if (li) {
      flushPara()
      const ordered = /\d/.test(li[1])
      if (list && list.ordered !== ordered) flushList()
      if (!list) list = { ordered, items: [] }
      list.items.push(li[2])
    } else if (h) {
      flushPara()
      flushList()
      blocks.push(<p key={`h${blocks.length}`}><strong>{inline(h[1], sources, vault, `h${blocks.length}`)}</strong></p>)
    } else if (!line.trim()) {
      flushPara()
      flushList()
    } else if (list && /^\s{2,}\S/.test(line)) {
      // eingerückte Fortsetzung eines Listenpunkts
      list.items[list.items.length - 1] += ' ' + line.trim()
    } else {
      flushList()
      para.push(line)
    }
  }
  flushPara()
  flushList()
  return <div className="chat-answer">{blocks}</div>
}
