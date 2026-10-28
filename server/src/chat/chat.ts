import type { AppConfig } from '../config.js'
import { Db, json } from '../db.js'
import type { LlmClient } from '../curator/llm.js'
import { dropEmptyHeadings } from '../curator/curator.js'
import { invalid } from '../lib/errors.js'
import { nameSimilarity } from '../lib/similarity.js'
import { norm } from '../lib/util.js'
import { stripBlockMarkers, stripDmBlocks } from '../notes/markdown.js'
import type { Note, Vault } from '../notes/vault.js'
import { restrictionAllows, type Restriction } from '../notes/search.js'
import type { VaultManager } from '../notes/vaults.js'

/*
 * Chat mit den Notizen – für kleine lokale Modelle gebaut:
 * Was in die Antwort gehört, wird vorher ohne LLM bestimmt (Namen, Typen, Volltext, Verknüpfungen)
 * und auf ein festes Zeichenbudget zugeschnitten. Das LLM formuliert nur noch die Antwort.
 */

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  question: string
  /** Bisheriger Verlauf (nur die letzten Beiträge gehen gekürzt mit) */
  history?: ChatTurn[]
  /** Hauptthemen der letzten Antwort – für Rückfragen wie „Und wo wohnt er?“ */
  previous?: string[]
  /** Ausdrücklich gewählte Notizen (z. B. „Fragen zu dieser Notiz“) */
  focus?: string[]
  campaign?: string | null
  visibility?: 'dm' | 'players'
  /** Bereich des Zugangs (Kampagne/Ordner/Typen) */
  restriction?: Restriction
}

export interface ChatSource {
  id: string
  title: string
  type: string
  /** focus: Hauptthema · mention: erwähnt in · related: verknüpft · list: Übersicht · fulltext: Volltexttreffer */
  role: 'focus' | 'mention' | 'related' | 'list' | 'fulltext' | 'timeline'
  reason: string
  /** Für Verweise in der Antwort: weitere Namen und Abschnitte des Eintrags */
  aliases?: string[]
  headings?: string[]
}

export interface ChatContext {
  question: string
  /** IDs der Hauptthemen (für die nächste Rückfrage) */
  focus: string[]
  sources: ChatSource[]
  /** Text, der an das LLM geht */
  text: string
  chars: number
  budget: number
  /** Erkannte Typen bei Übersichtsfragen („Welche Quests sind offen?“) */
  list_types: string[]
  /** Frage nach Stand/Verlauf: Sessions chronologisch, die neueste ausführlich */
  timeline: boolean
}

export interface ChatEvents {
  onContext?: (ctx: ChatContext) => void
  /** LLM ist frei und liest ein */
  onStart?: () => void
  onText?: (piece: string) => void
  /** Nachdenken des Modells (falls eingeschaltet) */
  onThinking?: (piece: string) => void
}

const STOP = new Set(
  (
    'der die das den dem des ein eine einer eines einem einen und oder aber von vom zu zum zur im in ins an am auf aus bei mit nach über unter vor für ' +
    'ist sind war waren wird werden wurde wurden hat haben hatte hatten kann können soll sollen muss müssen gibt gab es er sie ihr ihm ihn ihre sein seine ' +
    'ich du wir mir mich dir dich uns euch was wer wie wo wann warum wieso weshalb welche welcher welches welchen wem wen woher wohin womit worüber ' +
    'nicht noch schon auch nur mal denn doch ja nein so dann da hier dort alle alles etwas viel viele mehr sehr gerade eigentlich bitte ' +
    'weißt wissen weiß erzähl erzähle sag sage kennst kenne über über zusammenfassung infos info informationen gegen bis um als wenn ob dass ' +
    'the a an of and is are was who what where when why how'
  ).split(' '),
)

/** Wörter, an denen Übersichtsfragen nach einem Typ erkannt werden */
const TYPE_WORDS: Record<string, string[]> = {
  quest: ['quest', 'quests', 'aufgabe', 'aufgaben', 'auftrag', 'aufträge', 'mission', 'missionen'],
  npc: ['npc', 'npcs', 'person', 'personen', 'leute', 'figur', 'figuren', 'nsc', 'nscs'],
  character: ['charakter', 'charaktere', 'spielercharakter', 'spielercharaktere', 'held', 'helden', 'gruppe', 'party'],
  location: ['ort', 'orte', 'stadt', 'städte', 'dorf', 'dörfer', 'gegend', 'gegenden', 'dungeon', 'dungeons'],
  monster: ['monster', 'kreatur', 'kreaturen', 'gegner', 'feind', 'feinde'],
  item: ['gegenstand', 'gegenstände', 'item', 'items', 'beute', 'loot', 'schatz', 'schätze', 'waffe', 'waffen', 'artefakt', 'artefakte'],
  faction: ['fraktion', 'fraktionen', 'gilde', 'gilden', 'gruppierung', 'gruppierungen', 'orden'],
  session: ['session', 'sessions', 'sitzung', 'sitzungen', 'spielabend', 'spielabende'],
  script: ['skript', 'skripte', 'vorbereitung', 'vorbereitungen'],
  person: ['person', 'personen', 'kontakt', 'kontakte'],
  project: ['projekt', 'projekte'],
  meeting: ['meeting', 'meetings', 'besprechung', 'besprechungen', 'termin', 'termine'],
  task: ['aufgabe', 'aufgaben', 'todo', 'todos'],
}
const GENERIC_WORDS = new Set([...Object.values(TYPE_WORDS).flat(), 'kampagne', 'kampagnen', 'teil', 'kapitel', 'notiz', 'notizen', 'skript', 'recap', 'recaps'])
const LIST_HINT = /\b(welche[rsnm]?|alle|liste|übersicht|wie ?viele|offene?n?|erledigte?n?|gibt es)\b/i

/** Fragen nach Verlauf/Stand („Was ist der aktuelle Stand?“, „Was ist zuletzt passiert?“) */
const TIMELINE_HINT =
  /\b(aktuell\w*|stand|zuletzt|letzte[nrsm]?|neueste[nrsm]?|bisher|bis jetzt|passiert|geschehen|geschah|recap|zusammenfassung|fortschritt|verlauf|chronolog\w*|reihenfolge|wo (sind|stehen) wir|wie geht es weiter|abgereist|angekommen|als nächstes|gerade|momentan|derzeit|inzwischen|mittlerweile)\b/i
/** Einträge, die einen Verlauf erzählen (Chronik, Tagebuch, Zusammenfassung) */
const CHRONICLE_TITLE = /chronik|chronicle|tagebuch|journal|zusammenfassung|recap|verlauf|was bisher geschah/i
/** Abschnitte, die bei Stand-Fragen am meisten sagen */
const STATE_WORDS = ['bisher', 'ereignis', 'offen', 'stand', 'handlung', 'zusammenfassung', 'fazit', 'zuletzt', 'aktuell', 'ende', 'weiter']

const NO_INFO = 'Dazu habe ich in den Notizen nichts gefunden.'

/** Zahl im Titel („Session 3“, „Teil-2“, „Kapitel 4“) */
function titleNumber(title: string): number | null {
  const m = /(?:session|sitzung|teil|kapitel|folge|part|abend|tag)[\s_-]*(\d{1,4})/i.exec(title) ?? /(?:^|\D)(\d{1,3})(?:\D*$)/.exec(title.replace(/\d{4}-\d{2}-\d{2}/, ''))
  return m ? Number(m[1]) : null
}

interface Tok {
  w: string
  i: number
}

function tokenize(text: string): Tok[] {
  return [...text.normalize('NFC').replace(/[’`´]/g, "'").matchAll(/[\p{L}\p{N}']+/gu)].map((m, i) => ({ w: m[0].toLowerCase().replace(/^'+|'+$/g, ''), i })).filter((t) => t.w)
}

/** Wort der Frage passt zum Namenswort – auch gebeugt („Kefirs“, „Muffgallerten“) */
function wordEq(q: string, n: string): boolean {
  if (q === n) return true
  if (n.length < 3) return false
  return q === n + 's' || q === n + 'es' || q === n + 'n' || q === n + 'en' || q === n + "'s" || q === n + "'"
}

/** [[Ziel#Abschnitt|Text]] → lesbarer Text */
export function plainLinks(text: string): string {
  return text.replace(/!?\[\[([^\]|#]*)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g, (_m, t: string, h?: string, d?: string) => d ?? (h ? (t ? `${t} (${h})` : h) : t))
}

/** Abschnitte mit „(DM)“ in der Überschrift entfernen (Spieler-Sicht) */
function stripDmSections(body: string): string {
  return stripSections(body, (h) => /\(DM\)|\bnur DM\b/i.test(h))
}

/** Abschnitte (samt Unterabschnitten) entfernen, deren Überschrift passt */
function stripSections(body: string, test: (heading: string) => boolean): string {
  const lines = body.split('\n')
  const out: string[] = []
  let skip = 0
  for (const l of lines) {
    const h = /^(#{1,6})\s+(.*)$/.exec(l)
    if (h) {
      if (skip && h[1].length <= skip) skip = 0
      if (!skip && test(h[2])) {
        skip = h[1].length
        continue
      }
    }
    if (!skip) out.push(l)
  }
  return out.join('\n')
}

/** Notizinhalt ohne Markierungen, Titelzeile und leere Überschriften */
export function cleanBody(body: string, players: boolean): string {
  let b = players ? stripDmSections(stripDmBlocks(body)) : body
  b = stripBlockMarkers(b).replace(/<!--[\s\S]*?-->/g, '')
  b = b.replace(/^\s*#\s+.*(\n|$)/, '')
  // „Verknüpfte Einträge“ ist nur eine Linkliste – kostet Platz, sagt dem Modell wenig
  b = stripSections(b, (h) => /^verknüpfte einträge$/i.test(h.trim()))
  b = plainLinks(dropEmptyHeadings(b))
  return b.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

interface Section {
  heading: string
  text: string
  index: number
}

function splitSections(text: string): Section[] {
  const out: Section[] = []
  let cur: Section = { heading: '', text: '', index: 0 }
  for (const line of text.split('\n')) {
    if (/^#{2,6}\s/.test(line)) {
      if (cur.text.trim() || cur.heading) out.push(cur)
      cur = { heading: line.replace(/^#+\s+/, ''), text: line + '\n', index: out.length }
    } else cur.text += line + '\n'
  }
  if (cur.text.trim()) out.push(cur)
  return out.map((s, i) => ({ ...s, index: i, text: s.text.trim() }))
}

function hits(text: string, keywords: string[]): number {
  const t = text.toLowerCase()
  let n = 0
  for (const k of keywords) {
    let i = t.indexOf(k)
    while (i >= 0) {
      n++
      i = t.indexOf(k, i + k.length)
    }
  }
  return n
}

/** Längeren Text auf `max` Zeichen bringen: Abschnitte mit Suchbegriffen zuerst, Reihenfolge bleibt. */
export function selectSections(text: string, keywords: string[], max: number, opts: { tail?: boolean; headingWords?: string[] } = {}): string {
  if (text.length <= max) return text
  const secs = splitSections(text)
  const scored = secs.map((s) => ({
    s,
    score:
      hits(s.heading, keywords) * 3 +
      hits(s.heading, opts.headingWords ?? []) * 6 +
      // Bei Verläufen zählt die Position (das Neueste steht am Ende), nicht wie oft Wörter im Text vorkommen
      (opts.tail ? (s.index / Math.max(1, secs.length - 1)) * 10 : hits(s.text, keywords) * 2 + (s.index === 0 ? 1 : 0)),
  }))
  scored.sort((a, b) => b.score - a.score || a.s.index - b.s.index)
  const chosen: { s: Section; text: string }[] = []
  let used = 0
  for (const { s } of scored) {
    const room = max - used
    if (room < 120) break
    let t = s.text
    if (t.length > room) {
      // Zu langen Abschnitt um die Fundstellen herum kürzen
      const lines = t.split('\n')
      const keep = lines.filter((l, i) => i === 0 || hits(l, keywords))
      t = (keep.length > 1 ? keep.join('\n') : t).slice(0, room - 1) + '…'
    }
    chosen.push({ s, text: t })
    used += t.length + 2
  }
  chosen.sort((a, b) => a.s.index - b.s.index)
  return chosen.map((c, i) => (i && c.s.index !== chosen[i - 1].s.index + 1 ? '…\n' : '') + c.text).join('\n\n')
}

/** Inhaltswörter (ohne Füllwörter) */
function contentWords(text: string): string[] {
  return [...new Set(tokenize(text).map((t) => t.w).filter((w) => w.length >= 4 && !STOP.has(w)))]
}

/** Gleicher Wortstamm („Untersuchung“/„untersuchen“, „Wirt“/„Wirts“) */
function sameStem(a: string, b: string): boolean {
  const n = Math.min(6, a.length, b.length)
  return n >= 4 && a.slice(0, n) === b.slice(0, n)
}

function overlap(words: string[], other: string[]): number {
  return words.filter((w) => other.some((o) => sameStem(w, o))).length
}

/**
 * Offene Punkte einer Session-Notiz („- [ ] …“ unter „Offene Handlungsstränge“, „Offene Fäden …“) mit dem heutigen
 * Stand abgleichen – ohne LLM:
 * - passt der Punkt zu einer Quest, wird ihr Status angehängt („→ Quest „…“: erledigt“)
 * - steht er schon unter den Ereignissen derselben Notiz, wird das Ereignis angehängt
 * - abgehakte Punkte („- [x]“) werden als erledigt markiert
 */
export function annotateOpenThreads(text: string, quests: { title: string; status: string }[]): string {
  const secs = splitSections(text)
  const events = secs
    .filter((s) => /ereignis|was geschah|verlauf|deine session|zusammenfassung/i.test(s.heading))
    .flatMap((s) => s.text.split('\n').slice(1).flatMap((l) => l.split(/(?<=[.!?])\s+/)))
    .map((l) => l.replace(/^\s*([-*+]|\d+[.)])\s+/, '').trim())
    .filter((l) => l.length > 10 && l.length < 260)
  const qs = quests.map((q) => ({ ...q, words: contentWords(q.title.replace(/\([^)]*\)/g, ' ')), all: contentWords(q.title) }))
  return secs
    .map((s) => {
      if (!/offen|fäden|handlungsstr|to-?do|nächste/i.test(s.heading)) return s.text
      return s.text
        .split('\n')
        .map((line) => {
          const m = /^(\s*[-*+]\s+)\[( |x|X)\]\s+(.*)$/.exec(line) ?? /^(\s*[-*+]\s+)()(.*)$/.exec(line)
          if (!m) return line
          if (m[2].toLowerCase() === 'x') return `${m[1]}${m[3]} → erledigt (abgehakt)`
          const words = contentWords(m[3])
          if (!words.length) return line
          // Quest mit (fast) allen Wörtern des Quest-Titels im Punkt
          let best: { title: string; status: string; score: number } | null = null
          for (const q of qs) {
            const base = q.words.length ? q.words : q.all
            if (!base.length) continue
            const hit = overlap(base, words)
            const score = hit / base.length
            if ((hit >= 2 || base.length === 1) && score >= 0.6 && (!best || score > best.score)) best = { title: q.title, status: q.status || 'offen', score }
          }
          if (best) return `${line} → Quest „${best.title}“: ${best.status}`
          // Schon unter den Ereignissen derselben Notiz? (Nicht bei offenen Fragen – „Wer ist …?“ beantwortet kein Ereignis)
          const ev = /\?\s*$/.test(m[3]) ? undefined : events.find((e) => {
            const hit = overlap(words, contentWords(e))
            return hit >= 2 && hit / words.length >= 0.5
          })
          if (ev) return `${line} → laut Ereignissen bereits geschehen: „${short(ev, 100)}“`
          return line
        })
        .join('\n')
    })
    .join('\n\n')
}

/** Einzeiler für Listen: bevorzugt „Was bisher geschah“/„Zusammenfassung“, ohne Datei-Hinweise */
function summaryLine(text: string, max: number): string {
  const secs = splitSections(text)
  const best = secs.find((s) => /bisher|zusammenfassung|ereignis|überblick|deine session/i.test(s.heading))
  const t = (best ?? { text })
    .text.split('\n')
    .filter((l) => !/^\s*(originaldatei:|>|#)/i.test(l))
    .join(' ')
  return short(t, max)
}

function short(text: string, max: number): string {
  const t = text.replace(/^#+\s.*$/gm, '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1).replace(/\s\S*$/, '') + '…' : t
}

export class ChatService {
  constructor(
    private db: Db,
    private vaults: VaultManager,
    private llm: LlmClient,
    private config: AppConfig,
  ) {}

  private allowed(row: { campaign: string | null; visibility: string | null; path?: string; type?: string }, req: ChatRequest): boolean {
    if (req.visibility === 'players' && row.visibility !== 'players') return false
    if (req.campaign && row.campaign && norm(row.campaign) !== norm(req.campaign)) return false
    // Bereich des Zugangs (Kampagne/Ordner/Typen)
    if (req.restriction && !restrictionAllows(req.restriction, { campaign: row.campaign, visibility: row.visibility, path: row.path ?? '', type: row.type ?? '' })) return false
    return true
  }

  private typeLabel(v: Vault, type: string): string {
    return v.config.types[type]?.label ?? type
  }

  /** Namen aus Titeln und Aliassen in der Frage finden – exakt, gebeugt, Teilname oder Tippfehler. */
  detectEntities(v: Vault, question: string, req: ChatRequest): { id: string; title: string; type: string; matched: string; score: number }[] {
    const rows = this.db.all<any>(
      `SELECT nm.note_id, nm.display, nm.kind, n.title, n.type, n.campaign, n.visibility, n.path FROM names nm
       JOIN notes n ON n.vault = nm.vault AND n.id = nm.note_id WHERE nm.vault = ? AND nm.kind IN ('title','alias')`,
      v.id,
    )
    const q = tokenize(question)
    const content = q.filter((t) => !STOP.has(t.w))
    type Hit = { id: string; title: string; type: string; matched: string; score: number; span: [number, number] }
    const best = new Map<string, Hit>()
    const put = (h: Hit) => {
      const cur = best.get(h.id)
      if (!cur || h.score > cur.score) best.set(h.id, h)
    }
    for (const r of rows) {
      if (!this.allowed(r, req)) continue
      const nw = tokenize(r.display).map((t) => t.w)
      const meaningful = nw.filter((w) => !STOP.has(w))
      if (!meaningful.length || (nw.length === 1 && nw[0].length < 3)) continue
      const base = { id: r.note_id, title: r.title, type: r.type, matched: r.display }
      // 1. Ganzer Name kommt vor
      let found = false
      for (let i = 0; i + nw.length <= q.length && !found; i++) {
        if (nw.every((w, k) => wordEq(q[i + k].w, w))) {
          put({ ...base, score: r.kind === 'title' ? 1 : 0.97, span: [i, i + nw.length] })
          found = true
        }
      }
      if (found) continue
      // 2. Teil eines mehrteiligen Namens („Fyrn“ für „Fyrn Linstök“)
      if (nw.length > 1) {
        meaningful.forEach((w, k) => {
          // Gattungswörter („Session“ in „2026-10-10 Session 3“, „Quest“, „Ort“) machen keinen Namen aus
          if (w.length < 4 || GENERIC_WORDS.has(w) || /^\d+$/.test(w)) return
          const t = content.find((x) => wordEq(x.w, w))
          if (t) return put({ ...base, score: k === 0 ? 0.8 : 0.65, span: [t.i, t.i + 1] })
          // … auch mit Tippfehler („Muffelgallerte“ für „Muffgallerte jagen“)
          if (w.length < 5) return
          const f = content.find((x) => x.w.length >= 5 && x.w[0] === w[0] && nameSimilarity(x.w, w) >= 0.85)
          if (f) put({ ...base, score: 0.6, span: [f.i, f.i + 1] })
        })
      }
      // 3. Tippfehler / Schreibvariante („Muffelgalerte“)
      const n = nw.length
      for (let i = 0; i + n <= q.length; i++) {
        const gram = q.slice(i, i + n)
        if (gram.some((t) => STOP.has(t.w)) || gram.map((t) => t.w).join('').length < 5) continue
        const sim = nameSimilarity(gram.map((t) => t.w).join(' '), nw.join(' '))
        if (sim >= 0.85) put({ ...base, score: 0.7, span: [i, i + n] })
      }
    }
    const all = [...best.values()].sort((a, b) => b.score - a.score || b.span[1] - b.span[0] - (a.span[1] - a.span[0]) || a.title.length - b.title.length)
    // Teil-/Ähnlichkeitstreffer weglassen, wenn dieselben Wörter schon einen sicheren Treffer haben
    const sure = all.filter((h) => h.score >= 0.97)
    const covered = (h: Hit) => sure.some((s) => s.id !== h.id && s.span[0] <= h.span[0] && s.span[1] >= h.span[1])
    const out: Hit[] = []
    for (const h of all) {
      if (h.score < 0.97 && covered(h)) continue
      // Pro Stelle der Frage höchstens zwei unsichere Kandidaten
      if (h.score < 0.97 && out.filter((o) => o.score < 0.97 && o.span[0] === h.span[0]).length >= 2) continue
      out.push(h)
      if (out.length >= 4) break
    }
    return out.map(({ span: _s, ...h }) => h)
  }

  /** Typen, nach denen als Übersicht gefragt wird („Welche Quests sind offen?“) */
  detectListTypes(v: Vault, question: string): string[] {
    const words = tokenize(question).map((t) => t.w)
    const types = new Set<string>()
    for (const [type, def] of Object.entries(v.config.types)) {
      const list = [...(TYPE_WORDS[type] ?? []), ...tokenize(def.label ?? '').map((t) => t.w).filter((w) => w.length >= 3 && !STOP.has(w))]
      if (list.some((tw) => words.some((w) => wordEq(w, tw)))) types.add(type)
    }
    return [...types]
  }

  private propsLine(v: Vault, note: Note): string {
    const defs = v.config.types[note.type]?.properties ?? []
    const skip = new Set(['id', 'type', 'title', 'aliases', 'created', 'updated', 'campaign', 'visibility', 'tags', 'source'])
    const parts: string[] = []
    for (const [k, val] of Object.entries(note.frontmatter)) {
      if (skip.has(k) || val === null || val === undefined || val === '') continue
      const label = defs.find((d) => d.name === k)?.label ?? k
      const text = Array.isArray(val) ? val.map((x) => plainLinks(String(x))).join(', ') : typeof val === 'object' && !(val instanceof Date) ? '' : plainLinks(val instanceof Date ? val.toISOString().slice(0, 10) : String(val))
      if (text) parts.push(`${label}: ${text}`)
    }
    if (note.aliases.length) parts.push(`Auch genannt: ${note.aliases.join(', ')}`)
    return parts.join(' · ')
  }

  /**
   * Verlauf für „Was ist der aktuelle Stand?“: Sessions in der Reihenfolge, in der sie angelegt/hochgeladen wurden,
   * die neueste ausführlich (Abschnitte wie „Ereignisse“, „Offene Handlungsstränge“ zuerst), dazu das Ende von Chroniken.
   * Vorbereitungs-Skripte stehen nur in der Liste – sie sind nicht unbedingt gespielt.
   */
  private timelineContext(
    v: Vault,
    req: ChatRequest,
    keywords: string[],
    max: number,
    out: { push: (text: string) => void; seen: Set<string>; sources: ChatSource[]; room: () => number },
    /** Anteil des Platzes – kleiner, wenn noch ein Hauptthema folgt */
    factor = 1,
  ) {
    const players = req.visibility === 'players'
    const rows = this.db
      .all<any>(`SELECT id, title, type, campaign, visibility, path, frontmatter, body, created, updated FROM notes WHERE vault = ? AND type IN ('session','script','lore','note')`, v.id)
      .filter((r) => this.allowed(r, req) && (r.type === 'session' || r.type === 'script' || CHRONICLE_TITLE.test(r.title)))
      .map((r) => {
        const fm = json<Record<string, any>>(r.frontmatter, {})
        const d = fm.date ?? fm.played ?? null
        return { ...r, fm, date: d ? String(d).slice(0, 10) : null, tnum: titleNumber(r.title) }
      })
    type Row = (typeof rows)[number]
    // Reihenfolge = Reihenfolge des Anlegens/Hochladens (ohne Anlagedatum: letzte Änderung)
    const cmp = (a: Row, b: Row) => String(a.created ?? a.updated ?? '').localeCompare(String(b.created ?? b.updated ?? ''))
    const sessions = rows.filter((r) => r.type === 'session').sort(cmp)
    const scripts = rows.filter((r) => r.type === 'script').sort(cmp)
    const chronicles = rows.filter((r) => r.type !== 'session' && r.type !== 'script').sort(cmp)
    if (!sessions.length && !scripts.length && !chronicles.length) return

    const label = (r: Row) => (r.type === 'session' ? 'Session' : r.type === 'script' ? `Vorbereitung, ${r.fm.status ? String(r.fm.status) : 'Status unbekannt'}` : 'Chronik')
    const add = (r: Row, reason: string) => {
      out.seen.add(r.id)
      if (!out.sources.some((s) => s.id === r.id)) out.sources.push({ id: r.id, title: r.title, type: r.type, role: 'timeline', reason })
    }

    // Übersicht: älteste zuerst, die letzte Zeile ist der neueste Stand
    const listCap = Math.floor(max * 0.2)
    const lines: string[] = []
    let len = 0
    for (const r of [...sessions].reverse()) {
      const line = `${sessions.indexOf(r) + 1}. ${r.title}${r.date ? ` (${r.date})` : ''}: ${summaryLine(cleanBody(r.body, players), 110)}`
      if (len + line.length > listCap) break
      lines.unshift(line)
      len += line.length + 1
      add(r, 'Verlauf')
    }
    const prep = scripts.map((r) => `- ${r.title} (${label(r)})`).slice(-6)
    for (const r of scripts.slice(-6)) add(r, 'Vorbereitung')
    out.push(
      [
        `## Zeitlinie der Sessions (älteste zuerst – die letzte ist der aktuelle Stand)`,
        lines.length ? lines.join('\n') : '(keine Sessions)',
        prep.length ? `\nVorbereitete Skripte (nicht unbedingt gespielt):\n${prep.join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )

    // Aktueller Quest-Status – maßgeblicher als „offene Punkte“, die beim Schreiben einer Session-Notiz offen waren
    const quests = this.db
      .all<any>(`SELECT id, title, type, campaign, visibility, path, frontmatter FROM notes WHERE vault = ? AND type = 'quest'`, v.id)
      .filter((r) => this.allowed(r, req))
      .map((r) => ({ id: r.id, title: r.title as string, status: String(json<Record<string, any>>(r.frontmatter, {}).status ?? '').trim() }))
    if (quests.length) {
      const by = (s: string) => quests.filter((q) => (q.status || 'offen').toLowerCase() === s).map((q) => q.title)
      const open = by('offen')
      const done = quests.filter((q) => q.status && q.status.toLowerCase() !== 'offen').map((q) => `${q.title} (${q.status})`)
      out.push(`## Quests – aktueller Status (maßgeblich)\nOffen: ${open.join('; ') || '–'}\nErledigt/abgeschlossen: ${done.join('; ') || '–'}`)
    }

    const words = [...STATE_WORDS, ...keywords]
    const detail = (r: Row, heading: string, share: number, tail = false) => {
      const room = out.room()
      if (room < 300) return
      const head = `## ${heading}: ${r.title}${r.date ? ` (${r.date})` : ''}`
      const body = selectSections(annotateOpenThreads(cleanBody(r.body, players), quests), words, Math.max(250, Math.floor(room * share * factor) - head.length), { tail, headingWords: STATE_WORDS })
      if (!body) return
      out.push(`${head}\n${body.replace(/^(#{2,5}) /gm, '#$1 ')}`)
      add(r, heading)
    }
    const latest = sessions.at(-1)
    if (latest) detail(latest, 'Neueste Session (aktueller Stand)', 0.6)
    const before = sessions.at(-2)
    // Gleiche Session (z. B. Spieler-Recaps zu „Session 3“) nicht als „davor“ ausgeben
    const sameSession = (a: Row, b: Row) => (a.tnum !== null && a.tnum === b.tnum) || (!!a.date && a.date === b.date)
    if (before && latest) detail(before, sameSession(before, latest) ? 'Weitere Notizen zur selben Session' : 'Session davor', 0.4)
    const chronicle = chronicles.at(-1)
    if (chronicle) detail(chronicle, 'Chronik (Ende = neuester Stand)', 0.6, true)
    // Ohne Sessions: das neueste Skript, deutlich als Vorbereitung markiert
    if (!sessions.length && scripts.length) detail(scripts.at(-1)!, `Neueste Vorbereitung (${label(scripts.at(-1)!)})`, 0.6, true)
  }

  /** Kontext für eine Frage zusammenstellen – ohne LLM. */
  async buildContext(vaultId: string, req: ChatRequest, budget?: number): Promise<ChatContext> {
    const v = this.vaults.get(vaultId)
    const players = req.visibility === 'players'
    const question = req.question.trim()
    if (!question) throw invalid('Frage fehlt.')
    const max = budget ?? this.config.llm.chat_context_chars ?? 6000
    const keywords = [...new Set(tokenize(question).map((t) => t.w).filter((w) => w.length >= 3 && !STOP.has(w)))]

    const sources: ChatSource[] = []
    const seen = new Set<string>()
    const parts: string[] = []
    let used = 0
    const room = () => max - used
    const push = (text: string) => {
      parts.push(text)
      used += text.length + 2
    }
    const readable = (id: string): Note | null => {
      const n = v.readNote(id)
      return n && this.allowed(n, req) ? n : null
    }

    // 1. Was wird gefragt? Hauptthemen: ausdrücklich gewählt > in der Frage genannt > aus der letzten Antwort
    const analyse = (q: string) => {
      const ents = this.detectEntities(v, q, req)
      const ids: string[] = []
      for (const id of req.focus ?? []) if (readable(id)) ids.push(id)
      for (const e of ents) if (!ids.includes(e.id)) ids.push(e.id)
      const hint = LIST_HINT.test(q)
      // „Stand der Kampagne“ ist keine Frage nach der Liste aller Kampagnen
      const types = this.detectListTypes(v, q).filter((t) => t !== 'campaign' || hint)
      // Stand-Frage: ohne Thema – oder das Thema reist mit der Gruppe (Charaktere: „Wo ist die Gruppe gerade?“)
      const timeline = TIMELINE_HINT.test(q) && ents.filter((e) => ids.includes(e.id)).every((e) => e.type === 'character' || e.type === 'campaign') && ids.every((id) => ents.some((e) => e.id === id))
      const listing = types.length > 0 && !timeline && (ids.length === 0 || hint)
      return { ents, ids, types, listing, timeline }
    }
    let a = analyse(question)
    // Rückfrage ohne eigenes Thema („Nee, die sind schon abgereist“): die vorige Frage mitlesen
    const lastUser = [...(req.history ?? [])].reverse().find((t) => t.role === 'user' && t.content?.trim() && t.content.trim() !== question)?.content.trim()
    if (!a.ids.length && !a.listing && !a.timeline && lastUser) {
      const b = analyse(`${lastUser}\n${question}`)
      if (b.ids.length || b.listing || b.timeline) {
        a = b
        for (const w of tokenize(lastUser)) if (w.w.length >= 3 && !STOP.has(w.w) && !keywords.includes(w.w)) keywords.push(w.w)
      }
    }
    if (!a.ids.length && !a.listing && !a.timeline) for (const id of req.previous ?? []) if (readable(id)) a.ids.push(id)
    const focus = a.ids.slice(0, 3)
    const entities = a.ents.filter((e) => focus.includes(e.id))
    const listTypes = a.types
    const listing = a.listing
    const timeline = a.timeline

    // Verlauf: Sessions in zeitlicher Reihenfolge, die neueste ausführlich
    if (timeline) this.timelineContext(v, req, keywords, max, { push, seen, sources, room }, focus.length ? 0.5 : 1)

    // 2. Übersicht nach Typ
    if (listing) {
      const status = /\boffen/i.test(question) ? 'offen' : /\b(erledigt|abgeschlossen|geschafft)/i.test(question) ? 'erledigt' : null
      const params: any[] = [v.id, ...listTypes]
      const rows = this.db
        .all<any>(`SELECT id, title, type, campaign, visibility, path, frontmatter, body, created FROM notes WHERE vault = ? AND type IN (${listTypes.map(() => '?').join(',')})`, ...params)
        .filter((r) => this.allowed(r, req))
        .map((r) => ({ ...r, fm: json<Record<string, any>>(r.frontmatter, {}) }))
        .filter((r) => !status || !r.fm.status || norm(String(r.fm.status)) === status)
      rows.sort((a, b) =>
        a.type === 'session' && b.type === 'session' ? Number(b.fm.number ?? 0) - Number(a.fm.number ?? 0) || String(b.created).localeCompare(String(a.created)) : a.title.localeCompare(b.title, 'de'),
      )
      const cap = Math.floor(max * (focus.length ? 0.4 : 0.7))
      const lines: string[] = []
      let len = 0
      for (const r of rows) {
        const props = ['status', 'role', 'location', 'giver', 'number', 'date']
          .filter((k) => r.fm[k] !== undefined && r.fm[k] !== null && r.fm[k] !== '')
          .map((k) => plainLinks(String(r.fm[k])))
          .join(', ')
        const line = `- ${r.title}${props ? ` [${props}]` : ''}: ${short(cleanBody(r.body, players), 110)}`
        if (len + line.length > cap) break
        lines.push(line)
        len += line.length + 1
        seen.add(r.id)
        sources.push({ id: r.id, title: r.title, type: r.type, role: 'list', reason: `Übersicht ${this.typeLabel(v, r.type)}` })
      }
      const label = listTypes.map((t) => this.typeLabel(v, t)).join(', ')
      push(`## Übersicht: ${label}${status ? ` (${status})` : ''} – ${rows.length} Einträge${lines.length < rows.length ? `, ${lines.length} gezeigt` : ''}\n${lines.join('\n') || '(keine)'}`)
    }

    // 3. Hauptthemen mit Inhalt, Erwähnungen und Verknüpfungen
    const notes = focus.map((id) => readable(id)).filter((n): n is Note => !!n)
    const mainCap = notes.length ? Math.floor((room() * 0.62) / notes.length) : 0
    for (const n of notes) {
      seen.add(n.id)
      const e = entities.find((x) => x.id === n.id)
      sources.push({
        id: n.id,
        title: n.title,
        type: n.type,
        role: 'focus',
        reason: req.focus?.includes(n.id) ? 'ausgewählt' : e ? (e.score >= 0.97 ? `genannt („${e.matched}“)` : `vermutlich gemeint („${e.matched}“)`) : 'aus der vorigen Frage',
      })
      const props = this.propsLine(v, n)
      const head = `## ${n.title} (${this.typeLabel(v, n.type)})${props ? `\n${props}` : ''}`
      const body = selectSections(cleanBody(n.body, players), keywords, Math.max(300, mainCap - head.length))
      // Überschriften der Notiz eine Ebene tiefer, damit die Gliederung für das Modell eindeutig bleibt
      push(`${head}\n${body.replace(/^(#{2,5}) /gm, '#$1 ')}`)
    }
    if (notes.length) {
      // Wo kommen die Hauptthemen sonst vor? (Sessions, Skripte, andere Einträge)
      const mentionCap = Math.floor(room() * 0.45)
      const lines: string[] = []
      let len = 0
      const ctxSeen = new Set<string>()
      for (const n of notes) {
        const bl = v
          .backlinks(n.id)
          .filter((b) => !seen.has(b.source_id) && (!players || (!b.in_dm_block && b.source_visibility === 'players')))
          .sort((a, b) => Number(b.source_type === 'session' || b.source_type === 'script') - Number(a.source_type === 'session' || a.source_type === 'script'))
        for (const b of bl) {
          const src = readable(b.source_id)
          if (!src) continue
          let ctx = plainLinks(String(b.context ?? '').replace(/<!--[\s\S]*?-->/g, '')).replace(/\s+/g, ' ').trim()
          // Verweis aus einer Eigenschaft („giver: Kefir“): lieber Eigenschaften + Kurzfassung des Eintrags
          if (/^[\w-]+:\s/.test(ctx)) {
            const props = this.propsLine(v, src)
            ctx = `${props ? `[${props}] ` : ''}${short(cleanBody(src.body, players), 140)}`
          }
          const key = `${b.source_id}:${ctx}`
          if (!ctx || ctxSeen.has(key)) continue
          const line = `- ${b.source_title} (${this.typeLabel(v, b.source_type)}) über ${n.title}: ${ctx}`
          if (len + line.length > mentionCap) break
          ctxSeen.add(key)
          lines.push(line)
          len += line.length + 1
          if (!sources.some((s) => s.id === b.source_id)) sources.push({ id: b.source_id, title: b.source_title, type: b.source_type, role: 'mention', reason: `erwähnt ${n.title}` })
        }
      }
      for (const src of sources) if (src.role === 'mention') seen.add(src.id)
      if (lines.length) push(`## Erwähnungen\n${lines.join('\n')}`)

      // Direkt verknüpfte Einträge als Kurzfassung
      const relCap = Math.floor(room() * 0.5)
      const rel: string[] = []
      len = 0
      for (const n of notes) {
        for (const l of v.outgoing(n.id)) {
          if (!l.target_id || seen.has(l.target_id) || (players && l.in_dm_block)) continue
          const t = readable(l.target_id)
          if (!t) continue
          seen.add(t.id)
          const props = this.propsLine(v, t)
          const line = `- ${t.title} (${this.typeLabel(v, t.type)})${props ? ` [${props}]` : ''}: ${short(cleanBody(t.body, players), 140)}`
          if (len + line.length > relCap) continue
          rel.push(line)
          len += line.length + 1
          sources.push({ id: t.id, title: t.title, type: t.type, role: 'related', reason: `verknüpft mit ${n.title}` })
        }
      }
      if (rel.length) push(`## Verknüpft\n${rel.join('\n')}`)
    }

    // 4. Volltext: Begriffe der Frage (ODER-verknüpft), wenn noch Platz ist
    // (nicht bei Fragen nach dem Stand – da lenken Einzeltreffer nur von der Zeitlinie ab)
    if (keywords.length && room() > 400 && !timeline) {
      const fq = keywords.map((w) => `"${w.replace(/"/g, '')}"*`).join(' OR ')
      const col = players ? 'body_public' : 'body'
      let rows: any[] = []
      try {
        rows = this.db.all<any>(
          `SELECT n.id, n.title, n.type, n.campaign, n.visibility, n.path FROM notes_fts JOIN notes n ON n.vault = notes_fts.vault AND n.id = notes_fts.id
           WHERE notes_fts MATCH ? AND notes_fts.vault = ? ORDER BY bm25(notes_fts, 0.0, 0.0, 10.0, 6.0, 1.0, 1.0) LIMIT 12`,
          `{title aliases ${col}}: ${fq}`,
          v.id,
        )
      } catch {
        rows = []
      }
      const extra: string[] = []
      for (const r of rows) {
        if (seen.has(r.id) || !this.allowed(r, req)) continue
        if (room() < 300 || extra.length >= 4) break
        const n = readable(r.id)
        if (!n) continue
        const text = selectSections(cleanBody(n.body, players), keywords, Math.min(900, room() - 80))
        if (!text || !hits(n.title + ' ' + text, keywords)) continue
        seen.add(n.id)
        const block = `### ${n.title} (${this.typeLabel(v, n.type)})\n${text}`
        extra.push(block)
        used += block.length + 2
        sources.push({ id: n.id, title: n.title, type: n.type, role: 'fulltext', reason: 'enthält Begriffe der Frage' })
      }
      if (extra.length) parts.push(`## Weitere Fundstellen\n${extra.join('\n\n')}`)
    }

    const text = parts.join('\n\n')
    // Aliasse und Abschnitte mitgeben, damit die Oberfläche [Verweise] in der Antwort verlinken kann
    for (const src of sources) {
      src.aliases = this.db.all<{ display: string }>("SELECT display FROM names WHERE vault = ? AND note_id = ? AND kind = 'alias'", v.id, src.id).map((r) => r.display)
      if (src.role === 'focus' || src.role === 'fulltext' || src.role === 'timeline') src.headings = v.sectionHeadings(src.id).filter((h) => !players || !/\(DM\)/i.test(h))
    }
    return { question, focus, sources, text, chars: text.length, budget: max, list_types: listing ? listTypes : [], timeline }
  }

  private systemPrompt(v: Vault, players: boolean, timeline = false): string {
    const dnd = v.config.preset === 'dnd'
    return [
      `Du beantwortest Fragen zu ${dnd ? 'den Notizen einer Pen-&-Paper-Kampagne (D&D)' : 'persönlichen Notizen'}.`,
      'Regeln:',
      '- Nutze ausschließlich die Informationen unter NOTIZEN. Erfinde nichts dazu.',
      '- Steht die Antwort nicht in den Notizen, sage das in einem Satz.',
      '- Antworte auf Deutsch, knapp und konkret: wenige Sätze oder eine kurze Liste.',
      '- Nenne bei wichtigen Aussagen den Titel des Eintrags in eckigen Klammern, ohne Typ oder Zusatz, z. B. [Kefir].',
      timeline
        ? '- Die Sessions sind zeitlich geordnet. Der aktuelle Stand ergibt sich aus der NEUESTEN Session; ältere Sessions und Chroniken sind Vorgeschichte. Vorbereitete Skripte sind nicht unbedingt gespielt. Ob etwas noch offen ist, entscheidet der Quest-Status und der Hinweis „→ …“ hinter offenen Punkten – nenne erledigte Punkte nicht als offen.'
        : '',
      players ? '- Du sprichst mit Spielenden: gib nur wieder, was in den Notizen steht.' : '',
    ]
      .filter(Boolean)
      .join('\n')
  }

  /** Frage beantworten: Kontext bauen, dann (falls etwas gefunden wurde) das LLM antworten lassen. */
  async ask(vaultId: string, req: ChatRequest, ev: ChatEvents = {}, signal?: AbortSignal): Promise<{ answer: string; context: ChatContext; llm: boolean }> {
    const v = this.vaults.get(vaultId)
    const players = req.visibility === 'players'
    // Für das Budget mit dem längsten Systemprompt rechnen
    const longest = this.systemPrompt(v, players, true)
    const history = (req.history ?? [])
      .filter((t) => (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.trim())
      .slice(-4)
      .map((t) => ({ role: t.role, content: t.content.length > 500 ? t.content.slice(0, 500) + '…' : t.content }))
    const fixed = longest.length + history.reduce((n, t) => n + t.content.length, 0) + req.question.length + 40
    const cap = this.config.llm.chat_context_chars ?? 6000
    const budget = Math.max(1200, Math.min(cap, await this.llm.inputBudget(fixed, 700, 'chat')))
    const context = await this.buildContext(vaultId, req, budget)
    ev.onContext?.(context)
    if (!context.text.trim()) {
      ev.onText?.(NO_INFO)
      return { answer: NO_INFO, context, llm: false }
    }
    const answer = await this.llm.chatText({
      system: this.systemPrompt(v, players, context.timeline),
      messages: [...history, { role: 'user', content: `NOTIZEN:\n${context.text}\n\nFRAGE: ${context.question}` }],
      reserveTokens: 700,
      signal,
      onStart: ev.onStart,
      onText: ev.onText,
      onThinking: ev.onThinking,
    })
    return { answer: answer.trim(), context, llm: true }
  }
}
