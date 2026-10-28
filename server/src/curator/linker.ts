/**
 * Kurator-Modus „nur verknüpfen“: erkennt Erwähnungen vorhandener Notizen (Titel und Aliasse) und setzt Links.
 * Rein programmatisch – kein LLM, legt nichts an, ändert nur die erwähnende Notiz.
 */
import type { Db } from '../db.js'
import { norm } from '../lib/util.js'

export interface LinkTarget {
  title: string
  /** Titel und Aliasse */
  names: string[]
}

/** Kürzere Namen werden nur bei exakter Schreibweise verknüpft („Rom“ ≠ „rom“) */
const MIN_LEN = 3
const CASE_SENSITIVE_BELOW = 5

/** Bereiche, in denen nichts verknüpft wird: Code, bestehende Links, URLs, Überschriften, HTML */
function protectedRanges(body: string): [number, number][] {
  const out: [number, number][] = []
  const add = (re: RegExp) => {
    for (const m of body.matchAll(re)) out.push([m.index!, m.index! + m[0].length])
  }
  add(/^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm)
  add(/`[^`\n]+`/g)
  add(/!?\[\[[^\]\n]*\]\]/g)
  add(/!?\[[^\]\n]*\]\([^)\n]*\)/g)
  add(/<[^>\n]+>/g)
  add(/\b(?:https?:\/\/|www\.)\S+/g)
  add(/^#{1,6}[ \t].*$/gm)
  add(/%%[\s\S]*?%%/g)
  return out
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Erste Erwähnung je Ziel verlinken. Ziele, die schon verlinkt sind (alreadyLinked: norm(Titel)), und
 * mehrdeutige Namen (gehören zu mehreren Notizen) bleiben unberührt.
 */
export function linkMentions(body: string, targets: LinkTarget[], alreadyLinked: Set<string> = new Set()): { body: string; linked: string[] } {
  const owners = new Map<string, Set<string>>()
  for (const t of targets) for (const n of t.names) {
    const k = norm(n)
    if (!k) continue
    if (!owners.has(k)) owners.set(k, new Set())
    owners.get(k)!.add(t.title)
  }
  const candidates: { title: string; name: string }[] = []
  for (const t of targets) {
    if (t.names.some((n) => alreadyLinked.has(norm(n)))) continue
    for (const n of new Set(t.names.map((x) => x.trim()))) {
      // Zu kurz oder nur Zahlen/Datum (Tagebuch „2026-10-28“)
      if (n.length < MIN_LEN || /^[\d\s.:/-]+$/.test(n)) continue
      if (owners.get(norm(n))!.size > 1) continue
      candidates.push({ title: t.title, name: n })
    }
  }
  // Längere Namen zuerst („Neue Stadt“ vor „Stadt“)
  candidates.sort((a, b) => b.name.length - a.name.length)

  const used = protectedRanges(body)
  const overlaps = (s: number, e: number) => used.some(([a, b]) => s < b && e > a)
  const done = new Set<string>()
  const hits: { start: number; end: number; title: string }[] = []
  for (const c of candidates) {
    if (done.has(c.title)) continue
    const flags = c.name.length < CASE_SENSITIVE_BELOW ? 'gu' : 'giu'
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(c.name)}(?![\\p{L}\\p{N}_])`, flags)
    for (const m of body.matchAll(re)) {
      const s = m.index!
      const e = s + m[0].length
      if (overlaps(s, e)) continue
      hits.push({ start: s, end: e, title: c.title })
      used.push([s, e])
      done.add(c.title)
      break
    }
  }
  hits.sort((a, b) => b.start - a.start)
  let out = body
  for (const h of hits) {
    const text = out.slice(h.start, h.end)
    out = `${out.slice(0, h.start)}[[${text === h.title ? h.title : `${h.title}|${text}`}]]${out.slice(h.end)}`
  }
  return { body: out, linked: hits.map((h) => h.title).reverse() }
}

interface TargetRow {
  title: string
  path: string
  type: string
  campaign: string | null
  visibility: string | null
}

/** Alle Notizen des Vaults außer exceptId, mit Titel und Aliassen (allow: nur sichtbare Notizen) */
export function linkTargets(db: Db, vault: string, exceptId: string, allow?: (n: TargetRow) => boolean): LinkTarget[] {
  const rows = db.all<TargetRow & { note_id: string; display: string }>(
    "SELECT nm.note_id, n.title, n.path, n.type, n.campaign, n.visibility, nm.display FROM names nm JOIN notes n ON n.vault = nm.vault AND n.id = nm.note_id WHERE nm.vault = ? AND nm.note_id != ? AND nm.kind IN ('title', 'alias')",
    vault,
    exceptId,
  )
  const by = new Map<string, LinkTarget>()
  for (const r of rows) {
    if (allow && !allow(r)) continue
    const t = by.get(r.note_id) ?? { title: r.title, names: [r.title] }
    t.names.push(r.display)
    by.set(r.note_id, t)
  }
  return [...by.values()]
}

/** Text einer Notiz mit Links auf erwähnte Notizen; only = nur diese Titel (Vorschau/Anwenden eines geplanten Schritts) */
export function linkNoteBody(db: Db, vault: string, noteId: string, body: string, only?: string[], allow?: (n: TargetRow) => boolean): { body: string; linked: string[] } {
  const linked = new Set(db.all<{ target_norm: string }>('SELECT target_norm FROM links WHERE vault = ? AND source_id = ?', vault, noteId).map((r) => r.target_norm))
  let targets = linkTargets(db, vault, noteId, allow)
  if (only) {
    const keep = new Set(only.map(norm))
    targets = targets.filter((t) => keep.has(norm(t.title)))
  }
  return linkMentions(body, targets, linked)
}
