import { Db, json } from '../db.js'
import { isNamePrefix, nameSimilarity } from '../lib/similarity.js'
import { norm } from '../lib/util.js'

/** Typen, die keine „Dinge der Welt“ sind – werden nicht auf Duplikate geprüft */
const SKIP_TYPES = new Set(['session', 'campaign', 'fact', 'note', 'meeting', 'lore', 'script'])

export interface DupNote {
  id: string
  title: string
  type: string
  campaign: string | null
  aliases: string[]
  content: number
  created: string
}

export interface DuplicatePair {
  keep: DupNote
  other: DupNote
  score: number
  reason: string
}

/** Grobes Maß für eigenen Inhalt (ohne Überschriften, Markierungen, Leerraum) */
function contentSize(body: string): number {
  return body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^#{1,6}\s.*$/gm, '')
    .replace(/\s+/g, '').length
}

/** Mögliche Duplikate eines Vaults finden – ohne LLM, nur über Namen, Aliasse und Schreibweisen. */
export function findDuplicates(db: Db, vault: string, minScore = 0.85): DuplicatePair[] {
  const notes: DupNote[] = db
    .all<any>('SELECT id, title, type, campaign, frontmatter, body, created FROM notes WHERE vault = ?', vault)
    .filter((r) => !SKIP_TYPES.has(r.type))
    .map((r) => {
      const fm = json<Record<string, any>>(r.frontmatter, {})
      const aliases = Array.isArray(fm.aliases) ? fm.aliases.map(String) : fm.aliases ? [String(fm.aliases)] : []
      return { id: r.id, title: r.title, type: r.type, campaign: r.campaign, aliases, content: contentSize(r.body), created: String(r.created ?? '') }
    })

  const compare = (a: DupNote, b: DupNote): { score: number; reason: string; keepA: boolean } | null => {
    if (a.campaign && b.campaign && norm(a.campaign) !== norm(b.campaign)) return null
    const more = a.content !== b.content ? a.content > b.content : a.created <= b.created
    if (a.type !== b.type) {
      // Anderer Typ nur bei exakt gleichem Titel („Suche nach den Kultisten“ als Ort und als Quest)
      return norm(a.title) === norm(b.title) ? { score: 0.9, reason: `gleicher Titel, aber Typ „${a.type}“ und „${b.type}“`, keepA: more } : null
    }
    if (norm(a.title) === norm(b.title)) return { score: 1, reason: 'gleicher Titel', keepA: more }
    if (a.aliases.some((x) => norm(x) === norm(b.title))) return { score: 0.97, reason: `„${b.title}“ ist ein Alias von „${a.title}“`, keepA: true }
    if (b.aliases.some((x) => norm(x) === norm(a.title))) return { score: 0.97, reason: `„${a.title}“ ist ein Alias von „${b.title}“`, keepA: false }
    if (isNamePrefix(a.title, b.title)) return { score: 0.95, reason: `„${a.title}“ ist die Kurzform von „${b.title}“`, keepA: false }
    if (isNamePrefix(b.title, a.title)) return { score: 0.95, reason: `„${b.title}“ ist die Kurzform von „${a.title}“`, keepA: true }
    let best = 0
    for (const x of [a.title, ...a.aliases]) for (const y of [b.title, ...b.aliases]) best = Math.max(best, nameSimilarity(x, y))
    if (best < minScore) return null
    return { score: best, reason: `ähnliche Schreibweise (${Math.round(best * 100)} %)`, keepA: more }
  }

  const pairs: DuplicatePair[] = []
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const r = compare(notes[i], notes[j])
      if (!r) continue
      const [keep, other] = r.keepA ? [notes[i], notes[j]] : [notes[j], notes[i]]
      pairs.push({ keep, other, score: Math.round(r.score * 1000) / 1000, reason: r.reason })
    }
  }
  // Sicherste zuerst; jede Notiz wird höchstens einmal „weggeführt“
  pairs.sort((a, b) => b.score - a.score)
  const removed = new Set<string>()
  return pairs.filter((p) => {
    if (removed.has(p.other.id) || removed.has(p.keep.id)) return false
    removed.add(p.other.id)
    return true
  })
}
