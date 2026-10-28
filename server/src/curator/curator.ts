import { createTwoFilesPatch } from 'diff'
import { ulid } from 'ulid'
import { Db, json, nowIso } from '../db.js'
import { EventBus } from '../events.js'
import { ApiError, CancelledError, isCancelled, notFound } from '../lib/errors.js'
import { isNamePrefix, nameSimilarity } from '../lib/similarity.js'
import { norm } from '../lib/util.js'
import { composeNote, headings, listBlocks, mergeFrontmatterText, parseNote, removeBlock, setBlock, stringifyFrontmatter, stripBlockMarkers, type BlockInput } from '../notes/markdown.js'
import { Search } from '../notes/search.js'
import { stripLink, type Note, type Vault } from '../notes/vault.js'
import type { VaultManager } from '../notes/vaults.js'
import type { LlmClient } from './llm.js'
import { findDuplicates } from './duplicates.js'
import { linkNoteBody } from './linker.js'
import { RELATION_KINDS, type BlockSpec, type ExEntity, type ExRelation, type Extraction, type Operation, type Resolution } from './types.js'

/** Typen, die keine „Dinge der Welt“ sind und nicht extrahiert werden. */
const NON_ENTITY_TYPES = new Set(['session', 'campaign', 'fact', 'note', 'meeting', 'lore', 'quest', 'script'])
/** Eigenschaften, deren Änderung eher ein Widerspruch als ein Zustandswechsel ist. */
const IDENTITY_PROPS = new Set(['race', 'class', 'player', 'region', 'parent', 'origin', 'rarity', 'organization'])

export interface CurateInput {
  vault: string
  /** Quelle, z. B. whispernotes:job:ab12cd34 */
  sourceKey: string
  /** Notiz, aus der der Inhalt stammt (Session-Notiz) */
  sourceNoteId?: string | null
  /** Bezeichnung der Quelle, falls es keine Notiz gibt */
  sourceLabel?: string
  text: string
  /** Teil der Eingabe, den die Spielenden kennen (ohne DM-Lore). Standard: text */
  playersText?: string
  campaign?: string | null
  mode: 'auto' | 'review'
  /** Alles Erkannte als DM-Wissen behandeln (z. B. hochgeladene Abenteuer-Skripte) */
  forceDm?: boolean
  dryRun?: boolean
  inboxId?: string | null
}

/** Fortschritt eines laufenden Kurator-Laufs (für „Kurator arbeitet …“ in der Oberfläche) */
export interface RunProgress {
  run_id: string
  vault: string
  inbox_id: string | null
  source_key: string
  title: string
  dry_run: boolean
  phase: 'Erkennen' | 'Abgleichen' | 'Anwenden'
  step: number
  steps: number
  /** Vom LLM im aktuellen Abschnitt erzeugte Tokens */
  tokens: number
  started: string
}

export interface RunResult {
  run_id: string
  status: string
  created: number
  updated: number
  proposals: number
  operations: Operation[]
  commit: string | null
}

export function curatorKeys(sourceKey: string): string[] {
  return [
    sourceKey,
    `${sourceKey}:dm`,
    `${sourceKey}:links`,
    `${sourceKey}:links:dm`,
    `${sourceKey}:rel`,
    `${sourceKey}:rel:dm`,
    `${sourceKey}:rooms`,
    `${sourceKey}:rooms:dm`,
    `${sourceKey}:facts`,
    `${sourceKey}:facts:dm`,
    `${sourceKey}:progress`,
  ]
}

function uniq<T>(arr: T[], key: (x: T) => string = (x) => String(x)): T[] {
  const seen = new Set<string>()
  return arr.filter((x) => {
    const k = key(x)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/**
 * Nur echte Schreibvarianten als Alias behalten: keine Beschreibungen („Karawanenführerin Cydia“),
 * keine gebeugten Formen („Alchemisten“), keine Spielernamen.
 */
export function cleanVariants(name: string, variants: string[], exclude: Set<string> = new Set()): string[] {
  const n = norm(name)
  const words = (s: string) => norm(s).split(/[\s-]+/).filter(Boolean)
  return uniq(
    variants.filter((v) => {
      const x = norm(v)
      if (!x || x === n || x.length < 2 || exclude.has(x)) return false
      if (x.startsWith(n) && x.length - n.length <= 3) return false // Deklination
      if (n.startsWith(x) && n.length - x.length <= 3 && x.length >= 4) return false
      const w = words(v)
      // Name + Beschreibung („Karawanenführerin Cydia“) – aber der volle Name („Fyrn Linstök“ zu „Fyrn“) bleibt
      if (w.length > 1 && w.some((p) => words(name).includes(p)) && !isNamePrefix(name, v)) return false
      if (w.length > words(name).length + 1 && !isNamePrefix(name, v)) return false
      // Keine Schreibvariante, sondern eine Beschreibung („Kerzenzieher“ für „Fyrn Linstök“)
      if (nameSimilarity(v, name) < 0.45) return false
      return true
    }),
    norm,
  )
}

/**
 * Beschreibungen, die das LLM als Schreibweise angegeben hat („Kerzenzieher“, „Koboldwache im Schuppen“):
 * kurz, nicht namensähnlich – taugen als Rolle.
 */
export function roleFromVariants(name: string, variants: string[]): string | null {
  for (const v of variants) {
    const t = v.trim()
    if (!t || norm(t) === norm(name)) continue
    if (t.split(/\s+/).length > 4 || t.length > 40) continue
    if (nameSimilarity(t, name) >= 0.45) continue
    if (norm(t).includes(norm(name)) || norm(name).includes(norm(t))) continue
    return t
  }
  return null
}

const ROOM_RE = /\b(raum|räume|kammer|halle|saal|zimmer|keller|gang|korridor|gruft|krypta|nische|room|hall|chamber|crypt)\b/i

/** Überschrift eines Raums (ohne Zeichen, die Wiki-Links stören) */
export function roomHeading(name: string): string {
  return name.replace(/[[\]#|^]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Schlüssel, unter denen ein Raum gefunden wird: voller Name und Kurzform „Raum C“ */
function roomKeys(name: string): string[] {
  const keys = [norm(name), norm(roomHeading(name))]
  const m = /\b(?:raum|room)\s+([a-z0-9]{1,3})\b/i.exec(name) ?? /[-–]\s*([a-z0-9]{1,3})\s*$/i.exec(name)
  if (m) keys.push(`raum ${m[1].toLowerCase()}`)
  return uniq(keys, (k) => k)
}

/**
 * Sicherheitsnetz: Hat das LLM einen Raum doch als eigenen Ort geliefert und zugleich gesagt, in welchem Ort er liegt,
 * wird er als Raum dieses Ortes einsortiert.
 */
export function foldRooms(ex: Extraction): void {
  const locs = new Map(ex.entities.filter((e) => e.type === 'location').map((e) => [norm(e.name), e]))
  const fold = new Map<ExEntity, ExEntity>()
  for (const r of ex.relations ?? []) {
    if (r.kind !== 'parent' && r.kind !== 'location') continue
    const room = locs.get(norm(r.from))
    const parent = locs.get(norm(r.to))
    if (!room || !parent || room === parent || !ROOM_RE.test(room.name)) continue
    fold.set(room, parent)
  }
  if (!fold.size) return
  for (const [room, parent] of fold) {
    let target = parent
    while (fold.has(target)) target = fold.get(target)!
    target.rooms = uniq(
      [...(target.rooms ?? []), { name: room.name, description: [room.summary, ...room.facts, ...room.dm_facts].filter(Boolean).join(' ') }],
      (x) => norm(x.name),
    )
  }
  ex.entities = ex.entities.filter((e) => !fold.has(e))
  ex.relations = (ex.relations ?? []).filter((r) => {
    const room = [...fold.keys()].find((x) => norm(x.name) === norm(r.from))
    return !(room && norm(fold.get(room)!.name) === norm(r.to))
  })
}

/**
 * Was beim Zusammenführen von `other` in `keep` übernommen wird:
 * fehlende Eigenschaften, Aliasse (inkl. Titel von `other`), verwaltete Bereiche (als Bereiche, unter ihrer Überschrift)
 * und eigener Text ohne Titelzeile und leere Vorlagen-Überschriften.
 */
export function mergePlan(keep: Note, other: Note): { frontmatter: Record<string, any>; blocks: BlockInput[] } {
  const skip = new Set(['id', 'type', 'title', 'created', 'updated', 'aliases'])
  const frontmatter: Record<string, any> = {}
  for (const [k, val] of Object.entries(other.frontmatter)) {
    const cur = keep.frontmatter[k]
    if (!skip.has(k) && (cur === undefined || cur === null || cur === '') && val !== null && val !== '') frontmatter[k] = val
  }
  const aliases = uniq([...keep.aliases, other.title, ...other.aliases], norm).filter((a) => norm(a) !== norm(keep.title))
  if (aliases.length && JSON.stringify(aliases) !== JSON.stringify(keep.aliases)) frontmatter.aliases = aliases
  const keepKeys = new Set(listBlocks(keep.body).map((b) => b.key))
  const hs = headings(other.body)
  const blocks: BlockInput[] = []
  const otherBlocks = listBlocks(other.body)
  for (const b of otherBlocks) {
    if (keepKeys.has(b.key)) continue
    const h = [...hs].reverse().find((x) => x.index < b.start)
    blocks.push({ key: b.key, heading: h?.text ?? null, content: b.content, source: b.attrs.source ?? null, visibility: b.attrs.visibility ?? null, updated: b.attrs.updated })
  }
  let own = other.body
  for (const b of [...otherBlocks].reverse()) own = own.slice(0, b.start) + own.slice(b.end)
  own = dropEmptyHeadings(own.replace(/^\s*#\s+.*(\n|$)/, '')).trim()
  if (own) blocks.push({ key: `merge:${other.id}`, heading: `Zusammengeführt aus ${other.title}`, content: own, source: null, visibility: null })
  return { frontmatter, blocks }
}

/** Überschriften ohne Inhalt entfernen (z. B. leere Abschnitte aus Vorlagen) */
export function dropEmptyHeadings(text: string): string {
  const lines = text.split('\n')
  const level = (l: string) => /^(#{1,6})\s/.exec(l)?.[1].length ?? 0
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const lv = level(lines[i])
    if (lv) {
      let j = i + 1
      while (j < lines.length && !lines[j].trim()) j++
      if (j >= lines.length || (level(lines[j]) && level(lines[j]) <= lv)) continue
    }
    out.push(lines[i])
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

/** Eigenschaften vom Typ „Link“ als Wiki-Link speichern ("Koboldbau" → "[[Koboldbau]]") */
function asLinkProp(v: Vault, type: string, field: string, value: string): string {
  const def = (v.typeDef(type).properties ?? []).find((p) => p.name === field)
  if (def?.type !== 'link' || !value || /^\[\[.*\]\]$/.test(value.trim())) return value
  return `[[${value.trim()}]]`
}

/** Zeile unter die Überschrift eines Raums einfügen (Ende des Raum-Abschnitts) */
function addUnderRoom(content: string, anchor: string, line: string): string {
  const parts = content.split(/\n(?=### )/)
  return parts
    .map((p) => (p.startsWith(`### ${anchor}\n`) ? `${p.replace(/\s+$/, '')}\n- ${line}` : p))
    .join('\n')
}

function bullet(lines: string[]): string {
  return lines
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.startsWith('- ') ? l : `- ${l}`))
    .join('\n')
}

export class Curator {
  private search: Search
  /** Laufende Läufe mit Fortschritt */
  readonly progress = new Map<string, RunProgress>()

  constructor(
    private db: Db,
    private vaults: VaultManager,
    private llm: LlmClient,
    private events: EventBus,
  ) {
    this.search = new Search(db)
    // Läufe, die bei einem Neustart unterbrochen wurden, stehen sonst ewig auf „läuft“
    db.run("UPDATE runs SET status = 'interrupted', error = 'Durch Neustart unterbrochen.', finished = ? WHERE status = 'running'", nowIso())
  }

  // ============================================================ 1. Erkennen

  entityTypes(v: Vault): string[] {
    return Object.keys(v.config.types).filter((t) => !NON_ENTITY_TYPES.has(t))
  }

  extractionSchema(v: Vault): object {
    const types = this.entityTypes(v)
    const propNames = uniq(types.flatMap((t) => (v.typeDef(t).properties ?? []).map((p) => p.name))).filter((p) => p !== 'campaign')
    const props: Record<string, any> = {}
    for (const p of propNames) props[p] = { type: 'string' }
    return {
      type: 'object',
      properties: {
        entities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: types.length ? types : ['person'] },
              mentioned_as: { type: 'array', items: { type: 'string' } },
              summary: { type: 'string' },
              facts: { type: 'array', items: { type: 'string' } },
              properties: { type: 'object', properties: props },
              visibility: { type: 'string', enum: ['dm', 'players'] },
              confidence: { type: 'number' },
              rooms: {
                type: 'array',
                items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } }, required: ['name', 'description'] },
              },
            },
            required: ['name', 'type', 'mentioned_as', 'summary', 'facts', 'visibility', 'confidence'],
          },
        },
        events: {
          type: 'array',
          items: { type: 'object', properties: { text: { type: 'string' }, entities: { type: 'array', items: { type: 'string' } } }, required: ['text', 'entities'] },
        },
        quests: {
          type: 'array',
          items: {
            type: 'object',
            properties: { title: { type: 'string' }, status: { type: 'string', enum: ['offen', 'erledigt', 'gescheitert'] }, giver: { type: ['string', 'null'] }, summary: { type: 'string' } },
            required: ['title', 'status'],
          },
        },
        facts: {
          type: 'array',
          items: { type: 'object', properties: { text: { type: 'string' }, visibility: { type: 'string', enum: ['dm', 'players'] } }, required: ['text', 'visibility'] },
        },
        relations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
              kind: { type: 'string', enum: [...RELATION_KINDS] },
              label: { type: 'string' },
              inverse: { type: 'string' },
              visibility: { type: 'string', enum: ['dm', 'players'] },
            },
            required: ['from', 'to', 'kind', 'label', 'inverse'],
          },
        },
      },
      required: ['entities', 'events', 'quests', 'facts', 'relations'],
    }
  }

  knownNamesText(v: Vault, campaign: string | null | undefined, maxChars: number): string {
    const names = this.search.names(v.id, { campaign: campaign ?? undefined, types: this.entityTypes(v).concat('quest') })
    const lines: string[] = []
    let len = 0
    for (const n of names.items) {
      const s = `${n.name}${n.aliases.length ? ` [${n.aliases.join(', ')}]` : ''} (${n.type})`
      if (len + s.length + 2 > maxChars) break
      lines.push(s)
      len += s.length + 2
    }
    return lines.join(', ') || '(noch keine)'
  }

  systemPrompt(v: Vault, campaign: string | null | undefined, knownNames: string, hint = ''): string {
    const types = this.entityTypes(v)
      .map((t) => `${t} (${v.typeDef(t).label ?? t})`)
      .join(', ')
    if (v.config.curator.profile === 'dnd') {
      return [
        `Du bist der Archivar einer D&D-Kampagne${campaign ? ` („${campaign}“)` : ''}. Lies den Text und gib NUR JSON nach dem Schema zurück.`,
        `- Erkenne Entitäten der Typen: ${types}. Spielercharaktere sind "character", benannte Personen und ansprechbare Figuren "npc"${v.config.types.monster ? ', Gegner, Bestien und Kreaturen ohne eigene Rolle als Person (z. B. Schleim, Zombies, Wölfe) "monster"' : ''}.`,
        '- Verwende für bekannte Entitäten exakt den Namen aus der Liste „Bekannte Namen“ (auch wenn der Text ihn anders schreibt) und trage jede abweichende Schreibweise in "mentioned_as" ein.',
        '- "mentioned_as" enthält NUR abweichende Schreibweisen des Namens selbst (z. B. Verhörer aus der Transkription), keine Titel, Berufe oder Spielernamen.',
        '- Ähnlich klingende Namen in einem Text (z. B. „Cydia“ und „Zylia“ in derselben Rolle) sind meist dieselbe Figur: dann EINE Entität mit beiden Schreibweisen.',
        '- Nur Entitäten mit Eigennamen oder klar wiederkehrende, wichtige Figuren/Orte. Keine Gattungsbegriffe wie „der Wagen“ oder „die Sümpfe“.',
        '- Räume und Bereiche innerhalb eines Ortes (z. B. "Raum A", "Thronsaal", "Gruft") sind KEINE eigenen Entitäten: trage sie bei der übergeordneten location unter "rooms" ein (name, description). In "relations" darfst du einen Raumnamen als Ziel verwenden (z. B. Zombies → location → "Raum C").',
        '- "facts": kurze, eigenständige Aussagen (ein Satz) darüber, was in DIESEM Text über die Entität passiert oder bekannt wird.',
        '- "properties": nur, wenn der Text es eindeutig sagt (z. B. role = Beruf/Funktion wie "Schmiedin", attitude freundlich/neutral/feindlich, status lebendig/tot).',
        '- "quests": Aufträge/Ziele der Gruppe mit Status offen/erledigt/gescheitert. "facts" (oben, Liste): gesetzte Weltfakten.',
        '- "relations": Beziehungen zwischen erkannten Entitäten und Quests, die im Text stehen. "from"/"to" = exakter Name bzw. Quest-Titel. "kind": giver (Questgeber: Quest → Person), target (Ziel einer Quest: Quest → Monster/Person/Gegenstand/Ort), location (hält sich auf/befindet sich in: Wesen/Gegenstand → Ort), member (gehört zu: Person → Fraktion), owner (besitzt: Gegenstand → Besitzer), parent (Ort liegt in Ort), ally, enemy, other. "label" = kurze Bezeichnung aus Sicht von "from" (z. B. "Questgeber", "Ziel", "Aufenthaltsort"), "inverse" = aus Sicht von "to" (z. B. "gibt Quest", "Ziel von", "Bewohner").',
        '- Erfinde nichts. Nur was im Text steht. "confidence" 0..1: wie sicher die Entität korrekt erkannt ist.',
        '- "visibility": "dm" für Geheimnisse/Motive/Hintergründe, die die Spielenden nicht erfahren haben, sonst "players".',
        ...(hint ? [hint] : []),
        `Bekannte Namen: ${knownNames}`,
      ].join('\n')
    }
    return [
      'Du sortierst Notizen und Besprechungsprotokolle in eine persönliche Wissensdatenbank ein. Gib NUR JSON nach dem Schema zurück.',
      `- Erkenne Entitäten der Typen: ${types}.`,
      '- Verwende für bekannte Entitäten exakt den Namen aus „Bekannte Namen“ und trage abweichende Schreibweisen in "mentioned_as" ein.',
      '- "facts": kurze Aussagen, was der Text über die Entität sagt (Aufgaben, Entscheidungen, Termine mit Datum).',
      '- "quests": offene Aufgaben/Vorhaben mit Status offen/erledigt. Erfinde nichts. "visibility" immer "players".',
      '- "relations": Beziehungen zwischen erkannten Personen, Projekten und Aufgaben (kind: member = arbeitet an/gehört zu, giver = Auftraggeber, other). "label" aus Sicht von "from", "inverse" aus Sicht von "to".',
      `Bekannte Namen: ${knownNames}`,
    ].join('\n')
  }

  /** Text in Abschnitte ≤ budget zerlegen (an Überschriften/Absätzen). */
  chunk(text: string, budget: number): string[] {
    if (text.length <= budget) return [text]
    const parts = text.split(/\n(?=#{1,6}\s)|\n{2,}/)
    const chunks: string[] = []
    let cur = ''
    for (const p of parts) {
      if (p.length > budget) {
        if (cur) chunks.push(cur)
        cur = ''
        for (let i = 0; i < p.length; i += budget) chunks.push(p.slice(i, i + budget))
        continue
      }
      if (cur.length + p.length + 2 > budget) {
        chunks.push(cur)
        cur = p
      } else cur = cur ? `${cur}\n\n${p}` : p
    }
    if (cur) chunks.push(cur)
    return chunks
  }

  normalizeExtraction(raw: any, allowedTypes: string[]): Extraction {
    const str = (x: any) => (typeof x === 'string' ? x.trim() : x === null || x === undefined ? '' : String(x).trim())
    const arr = (x: any) => (Array.isArray(x) ? x : [])
    const entities: ExEntity[] = arr(raw?.entities)
      .map((e: any) => ({
        name: str(e?.name),
        type: str(e?.type).toLowerCase(),
        mentioned_as: arr(e?.mentioned_as).map(str).filter(Boolean),
        summary: str(e?.summary),
        facts: arr(e?.facts).map(str).filter(Boolean),
        properties: Object.fromEntries(
          Object.entries(e?.properties && typeof e.properties === 'object' ? e.properties : {})
            .map(([k, v]) => [k, str(v)])
            .filter(([, v]) => v && !['null', 'unbekannt', 'unknown', 'none'].includes(String(v).toLowerCase())),
        ),
        visibility: (e?.visibility === 'dm' ? 'dm' : 'players') as ExEntity['visibility'],
        confidence: Math.max(0, Math.min(1, Number(e?.confidence ?? 0.7) || 0.7)),
        rooms: arr(e?.rooms)
          .map((r: any) => ({ name: str(r?.name), description: str(r?.description) }))
          .filter((r: { name: string }) => r.name),
      }))
      .map((e): ExEntity => (e.visibility === 'dm' ? { ...e, dm_facts: e.facts, facts: [] } : { ...e, dm_facts: [] }))
      .filter((e: ExEntity) => e.name && e.name.length <= 80 && allowedTypes.includes(e.type))
    return {
      entities,
      events: arr(raw?.events)
        .map((e: any) => ({ text: str(e?.text), entities: arr(e?.entities).map(str).filter(Boolean) }))
        .filter((e: any) => e.text),
      quests: arr(raw?.quests)
        .map((q: any) => ({ title: str(q?.title), status: ['offen', 'erledigt', 'gescheitert'].includes(str(q?.status)) ? str(q?.status) : 'offen', giver: str(q?.giver) || null, summary: str(q?.summary) }))
        .filter((q: any) => q.title),
      facts: arr(raw?.facts)
        .map((f: any) => (typeof f === 'string' ? { text: f.trim(), visibility: 'players' } : { text: str(f?.text), visibility: f?.visibility === 'dm' ? 'dm' : 'players' }))
        .filter((f: any) => f.text) as Extraction['facts'],
      relations: arr(raw?.relations)
        .map(
          (r: any): ExRelation => ({
            from: str(r?.from),
            to: str(r?.to),
            kind: (RELATION_KINDS as readonly string[]).includes(str(r?.kind)) ? (str(r?.kind) as ExRelation['kind']) : 'other',
            label: str(r?.label) || 'Verknüpft mit',
            inverse: str(r?.inverse) || 'Verknüpft mit',
            visibility: r?.visibility === 'dm' ? 'dm' : 'players',
          }),
        )
        .filter((r: ExRelation) => r.from && r.to && norm(r.from) !== norm(r.to)),
    }
  }

  mergeExtractions(list: Extraction[]): Extraction {
    const ents = new Map<string, ExEntity>()
    // Bei widersprüchlichen Typen für denselben Namen gewinnt der „lebendigere“ Typ
    const rank = (t: string) => {
      const i = ['character', 'npc', 'monster', 'person', 'faction', 'location', 'item'].indexOf(t)
      return i < 0 ? 99 : i
    }
    for (const ex of list) {
      for (const e of ex.entities) {
        const k = norm(e.name)
        const cur = ents.get(k)
        if (cur && cur.type !== e.type && rank(e.type) < rank(cur.type)) cur.type = e.type
        if (!cur) {
          ents.set(k, { ...e, mentioned_as: [...e.mentioned_as], facts: [...e.facts], dm_facts: [...e.dm_facts], properties: { ...e.properties } })
          continue
        }
        cur.mentioned_as = uniq([...cur.mentioned_as, ...e.mentioned_as], norm)
        cur.facts = uniq([...cur.facts, ...e.facts], norm)
        cur.dm_facts = uniq([...cur.dm_facts, ...e.dm_facts], norm)
        // Kurzbeschreibung bevorzugt aus dem Spieler-sichtbaren Teil
        cur.summary = cur.visibility === 'dm' && e.visibility === 'players' ? e.summary || cur.summary : cur.summary || e.summary
        cur.properties = { ...cur.properties, ...e.properties }
        cur.confidence = Math.max(cur.confidence, e.confidence)
        cur.rooms = uniq([...(cur.rooms ?? []), ...(e.rooms ?? [])], (r) => norm(r.name))
        if (e.visibility === 'players') cur.visibility = 'players'
      }
    }
    // „Fyrn“ und „Fyrn Linstök“ im selben Text → eine Entität mit dem vollen Namen
    const all = [...ents.values()]
    for (const short of all) {
      const long = all.find((l) => l !== short && l.type === short.type && ents.has(norm(l.name)) && isNamePrefix(short.name, l.name))
      if (!long || !ents.has(norm(short.name))) continue
      long.mentioned_as = uniq([...long.mentioned_as, short.name, ...short.mentioned_as], norm)
      long.facts = uniq([...long.facts, ...short.facts], norm)
      long.dm_facts = uniq([...long.dm_facts, ...short.dm_facts], norm)
      long.summary = long.summary || short.summary
      long.properties = { ...short.properties, ...long.properties }
      long.rooms = uniq([...(long.rooms ?? []), ...(short.rooms ?? [])], (r) => norm(r.name))
      if (short.visibility === 'players') long.visibility = 'players'
      ents.delete(norm(short.name))
      // Beziehungen auf den vollen Namen umbiegen
      for (const ex of list) for (const r of ex.relations ?? []) {
        if (norm(r.from) === norm(short.name)) r.from = long.name
        if (norm(r.to) === norm(short.name)) r.to = long.name
      }
    }
    return {
      entities: [...ents.values()],
      events: list.flatMap((x) => x.events),
      quests: uniq(
        list.flatMap((x) => x.quests),
        (q) => norm(q.title),
      ),
      facts: uniq(
        list.flatMap((x) => x.facts),
        (f) => norm(f.text),
      ),
      relations: uniq(
        list.flatMap((x) => x.relations ?? []),
        (r) => `${norm(r.from)}|${r.kind}|${norm(r.to)}`,
      ),
    }
  }

  async extract(
    v: Vault,
    text: string,
    campaign: string | null | undefined,
    hint = '',
    signal?: AbortSignal,
    onChunk?: (i: number, n: number) => void,
    onToken?: (n: number) => void,
  ): Promise<{ extraction: Extraction; chunks: number; model: string | null; context: number; warnings: string[] }> {
    const info = await this.llm.info()
    // Namensliste höchstens ein Viertel des Kontexts
    const namesBudget = Math.max(400, Math.floor((info.context * 3) / 4))
    const known = this.knownNamesText(v, campaign, namesBudget)
    const system = this.systemPrompt(v, campaign, known, hint)
    // Kleine Abschnitte (~4 Seiten): kürzere Antworten, die sicher vollständig sind – auch bei langsamen Modellen
    const budget = Math.min(await this.llm.inputBudget(system.length, 4096), 12_000)
    const chunks = this.chunk(text, budget)
    const schema = this.extractionSchema(v)
    const results: Extraction[] = []
    const warnings: string[] = []
    const allowed = this.entityTypes(v)
    for (let i = 0; i < chunks.length; i++) {
      if (signal?.aborted) throw new CancelledError()
      onChunk?.(i + 1, chunks.length)
      try {
        const raw = await this.llm.chatJson({ system, user: chunks[i], schema, temperature: 0.1, reserveTokens: 4096, signal, onToken })
        results.push(this.normalizeExtraction(raw, allowed))
      } catch (e) {
        if (isCancelled(e)) throw e
        // LLM nicht erreichbar oder der einzige Abschnitt scheitert → Lauf abbrechen.
        // Zeitüberschreitung/abgeschnittene Antwort in einem von mehreren Abschnitten → überspringen.
        const unreachable = e instanceof ApiError && e.code === 'llm_unavailable' && e.details?.reason === 'unreachable'
        if (chunks.length === 1 || unreachable) throw e
        warnings.push(`Abschnitt ${i + 1}/${chunks.length} übersprungen: ${(e as Error).message}`)
      }
    }
    if (!results.length)
      throw Object.assign(new ApiError('llm_unavailable', `Kein Abschnitt konnte ausgewertet werden. ${warnings[0] ?? ''}`, { reason: 'timeout' }), { noRetry: true })
    return { extraction: this.mergeExtractions(results), chunks: chunks.length, model: info.model, context: info.context, warnings }
  }

  // ============================================================ 2. Abgleichen

  async resolveEntity(v: Vault, e: ExEntity, campaign: string | null | undefined, signal?: AbortSignal): Promise<Resolution> {
    const variants = uniq([e.name, ...e.mentioned_as], norm)
    // 1. exakter Treffer (Titel/Alias, gleiche Kampagne, gleicher Typ – notfalls typunabhängig)
    for (const opt of [{ type: e.type }, {}] as { type?: string }[]) {
      for (const n of variants) {
        const id = v.resolveName(n, { ...opt, campaign: campaign ?? null })
        if (id) {
          const note = v.readNote(id)
          if (!note) continue
          if (!opt.type && NON_ENTITY_TYPES.has(note.type)) continue
          if (campaign && note.campaign && norm(note.campaign) !== norm(campaign)) continue
          const res: Resolution = { name: e.name, type: note.type, match: id, title: note.title, confidence: 1, method: 'exact', candidates: [{ id, title: note.title, score: 1 }] }
          // Gibt es eine zweite Notiz derselben Entität? → Zusammenführen vorschlagen
          const dup = this.candidates(v, variants, e.type, campaign).find((c) => c.id !== id && c.score >= 0.93)
          if (dup) res.duplicate_of = dup
          return res
        }
      }
    }
    // 2. Kandidaten über Ähnlichkeit + Volltext
    const cands = this.candidates(v, variants, e.type, campaign).slice(0, 3)
    if (!cands.length || cands[0].score < 0.6) return { name: e.name, type: e.type, match: 'new', confidence: e.confidence, method: 'new', candidates: cands }
    const [top, second] = cands
    if (top.score >= 0.92 && (!second || second.score < top.score - 0.1)) {
      return { name: e.name, type: e.type, match: top.id, title: top.title, confidence: Math.min(e.confidence, top.score), method: 'similar', candidates: cands }
    }
    // 3. LLM entscheidet
    const list = cands
      .map((c, i) => {
        const n = v.readNote(c.id)
        return `${i + 1}. ${c.id} ${c.title} (${n?.type}) – ${v.summaryOf(c.id, 220)}${n?.aliases.length ? `; Aliasse: ${n.aliases.join(', ')}` : ''}`
      })
      .join('\n')
    const system =
      'Entscheide, ob die neue Erwähnung dieselbe Entität ist wie einer der Kandidaten. Achte auf Verhörer/Schreibvarianten aus Transkripten. ' +
      'Antworte NUR mit JSON {"match": "<id>|new", "confidence": 0..1, "reason": "…"}.'
    const user = `Neue Erwähnung: "${variants.join(' / ')}" (${e.type}) – ${[e.summary, ...e.facts].filter(Boolean).join('; ').slice(0, 600)}\nKandidaten:\n${list}`
    const schema = {
      type: 'object',
      properties: { match: { type: 'string', enum: [...cands.map((c) => c.id), 'new'] }, confidence: { type: 'number' }, reason: { type: 'string' } },
      required: ['match', 'confidence', 'reason'],
    }
    const r = await this.llm.chatJson<{ match: string; confidence: number; reason: string }>({ system, user, schema, temperature: 0.1, reserveTokens: 256, signal })
    const chosen = cands.find((c) => c.id === r.match)
    const conf = Math.max(0, Math.min(1, Number(r.confidence) || 0.5))
    if (!chosen) return { name: e.name, type: e.type, match: 'new', confidence: Math.min(e.confidence, conf), method: 'llm', candidates: cands, reason: r.reason }
    return { name: e.name, type: e.type, match: chosen.id, title: chosen.title, confidence: Math.min(e.confidence, conf), method: 'llm', candidates: cands, reason: r.reason }
  }

  private candidates(v: Vault, variants: string[], type: string, campaign: string | null | undefined) {
    const best = new Map<string, { id: string; title: string; score: number }>()
    for (const n of variants) {
      for (const c of this.search.resolve(v, n, { type, campaign: campaign ?? undefined, limit: 5 })) {
        const cur = best.get(c.id)
        if (!cur || c.score > cur.score) best.set(c.id, { id: c.id, title: c.title, score: c.score })
      }
    }
    return [...best.values()].sort((a, b) => b.score - a.score)
  }

  // ============================================================ 3. Planen

  plan(
    v: Vault,
    ex: Extraction,
    resolutions: Resolution[],
    ctx: { sourceKey: string; sourceLink: string | null; sourceNoteId?: string | null; campaign: string | null; mode: 'auto' | 'review'; exclude?: Set<string>; playersText?: string; forceDm?: boolean },
  ): Operation[] {
    const cfg = v.config.curator
    const ops: Operation[] = []
    const section = cfg.section
    const titlesByType = new Map<string, string[]>()
    const dmTitlesByType = new Map<string, string[]>()
    const linkTitle = (type: string, title: string, dm = false) => {
      const map = dm || ctx.forceDm ? dmTitlesByType : titlesByType
      map.set(type, uniq([...(map.get(type) ?? []), title], norm))
    }

    /** Räume eines Ortes als Abschnitt „Räume“ mit einer Unterüberschrift je Raum */
    const roomsBlock = (e: ExEntity): BlockSpec[] => {
      if (!e.rooms?.length) return []
      const dm = !!ctx.forceDm || (e.visibility === 'dm' && !e.facts.length)
      const content = e.rooms.map((r) => `### ${roomHeading(r.name)}\n${r.description || '–'}`).join('\n\n')
      return [{ key: dm ? `${ctx.sourceKey}:rooms:dm` : `${ctx.sourceKey}:rooms`, heading: 'Räume', content, source: ctx.sourceLink, visibility: dm ? 'dm' : null }]
    }

    ex.entities.forEach((e, i) => {
      const r = resolutions[i]
      const playersNorm = ctx.playersText ? norm(ctx.playersText) : null
      const namedForPlayers = !!playersNorm && [e.name, ...e.mentioned_as].some((n) => n.length > 2 && playersNorm.includes(norm(n)))
      const playersVisible = e.visibility === 'players' || e.facts.length > 0 || namedForPlayers
      const content = (withSummary: boolean) => {
        const lines = [...(withSummary && playersVisible && e.summary ? [e.summary] : []), ...e.facts]
        return bullet(lines)
      }
      const dmContent = (withSummary: boolean) => bullet([...(withSummary && !playersVisible && e.summary ? [e.summary] : []), ...e.dm_facts])
      const dmBlock = (type: string): BlockSpec | null => {
        const c = dmContent(r.match === 'new')
        return c ? { key: `${ctx.sourceKey}:dm`, heading: v.typeDef(type).section ?? section, content: c, source: ctx.sourceLink, visibility: 'dm' } : null
      }
      const key = ctx.sourceKey
      if (r.match === 'new') {
        const props: Record<string, any> = {}
        const allowed = new Set((v.typeDef(e.type).properties ?? []).map((p) => p.name))
        for (const [k, val] of Object.entries(e.properties)) if (allowed.has(k) && k !== 'campaign') props[k] = asLinkProp(v, e.type, k, val)
        const aliases = cleanVariants(e.name, e.mentioned_as, ctx.exclude)
        const fm: Record<string, any> = {}
        if (ctx.campaign && cfg.profile === 'dnd') fm.campaign = ctx.campaign
        // Beschreibung, die das LLM als Schreibweise geliefert hat, als Rolle übernehmen
        if (allowed.has('role') && !props.role) {
          const role = roleFromVariants(e.name, e.mentioned_as)
          if (role) props.role = role
        }
        Object.assign(fm, props)
        if (aliases.length) fm.aliases = aliases
        fm.visibility = playersVisible ? 'players' : 'dm'
        const heading = v.typeDef(e.type).section ?? section
        const pc = content(true)
        const dm = dmBlock(e.type)
        const main: BlockSpec | null = pc ? { key, heading, content: pc, source: ctx.sourceLink, visibility: null } : dm
        const block = main ?? { key, heading, content: bullet([`Erwähnt in ${ctx.sourceLink ?? 'einer Quelle'}`]), source: ctx.sourceLink, visibility: null }
        ops.push({
          op: 'create_entity',
          type: e.type,
          title: e.name,
          campaign: ctx.campaign,
          frontmatter: fm,
          block,
          extra_blocks: [...(main === dm || !dm ? [] : [dm]), ...roomsBlock(e)],
          confidence: r.confidence,
          reason: e.summary || undefined,
        })
        linkTitle(e.type, e.name, !playersVisible)
        return
      }
      const note = v.readNote(r.match)
      if (!note) return
      linkTitle(note.type, note.title, !playersVisible)
      for (const rb of roomsBlock(e))
        ops.push({ op: 'append_block', note_id: note.id, note_title: note.title, block: rb, confidence: r.confidence })
      const blockVis = null
      const facts = content(false)
      const dm = dmBlock(note.type)
      if (dm)
        ops.push({
          op: 'append_block',
          note_id: note.id,
          note_title: note.title,
          block: dm,
          confidence: r.confidence,
          reason: r.method !== 'exact' ? `Zugeordnet über ${r.method === 'llm' ? 'LLM' : 'Ähnlichkeit'}${r.reason ? `: ${r.reason}` : ''}` : undefined,
        })
      if (facts) {
        ops.push({
          op: 'append_block',
          note_id: note.id,
          note_title: note.title,
          block: { key, heading: v.typeDef(note.type).section ?? section, content: facts, source: ctx.sourceLink, visibility: blockVis },
          confidence: r.confidence,
          reason: r.method !== 'exact' ? `Zugeordnet über ${r.method === 'llm' ? 'LLM' : 'Ähnlichkeit'}${r.reason ? `: ${r.reason}` : ''}` : undefined,
        })
      } else if (ctx.sourceLink && !dm) {
        ops.push({
          op: 'add_mention',
          note_id: note.id,
          note_title: note.title,
          block: { key, heading: v.typeDef(note.type).section ?? section, content: `- Erwähnt in ${ctx.sourceLink}`, source: ctx.sourceLink, visibility: blockVis },
          confidence: r.confidence,
        })
      }
      if (cfg.learn_aliases) {
        const known = new Set([note.title, ...note.aliases].map(norm))
        for (const a of [...cleanVariants(note.title, [e.name, ...e.mentioned_as], ctx.exclude)]) {
          if (known.has(norm(a))) continue
          known.add(norm(a))
          ops.push({ op: 'add_alias', note_id: note.id, note_title: note.title, alias: a, confidence: r.confidence, reason: `Schreibvariante „${a}“ für ${note.title}` })
        }
      }
      const allowed = new Set((v.typeDef(note.type).properties ?? []).map((p) => p.name))
      for (const [k, val] of Object.entries(e.properties)) {
        if (!allowed.has(k) || k === 'campaign') continue
        const cur = note.frontmatter[k]
        const curStr = stripLink(cur)
        if (curStr && norm(curStr) === norm(val)) continue
        const kind = curStr && IDENTITY_PROPS.has(k) ? 'contradiction' : 'update_property'
        ops.push({
          op: kind,
          note_id: note.id,
          note_title: note.title,
          field: k,
          from: cur ?? null,
          to: val,
          confidence: Math.min(r.confidence, e.confidence),
          reason: curStr ? `${ctx.sourceLink ?? 'Quelle'}: „${k}“ ist jetzt „${val}“ (bisher „${curStr}“)` : `${ctx.sourceLink ?? 'Quelle'} nennt ${k}: „${val}“`,
        })
      }
      if (r.duplicate_of) {
        ops.push({
          op: 'merge_entities',
          note_id: note.id,
          note_title: note.title,
          other_id: r.duplicate_of.id,
          other_title: r.duplicate_of.title,
          confidence: r.duplicate_of.score,
          reason: `„${r.duplicate_of.title}“ ist vermutlich dieselbe Entität wie „${note.title}“ (Ähnlichkeit ${Math.round(r.duplicate_of.score * 100)} %)`,
        })
      }
    })

    // Quests
    if (v.config.types.quest) {
      for (const q of ex.quests) {
        const id = v.resolveName(q.title, { type: 'quest', campaign: ctx.campaign })
        const similar = id ? null : this.candidates(v, [q.title], 'quest', ctx.campaign).find((c) => c.score >= 0.9)
        const qid = id ?? similar?.id ?? null
        const progress = bullet([q.summary || ''].filter(Boolean))
        if (!qid) {
          const fm: Record<string, any> = {}
          if (ctx.campaign) fm.campaign = ctx.campaign
          fm.status = q.status
          if (q.giver) fm.giver = `[[${q.giver}]]`
          fm.visibility = ctx.forceDm ? 'dm' : 'players'
          ops.push({
            op: 'create_entity',
            type: 'quest',
            title: q.title,
            campaign: ctx.campaign,
            frontmatter: fm,
            block: { key: `${ctx.sourceKey}:progress`, heading: 'Fortschritt', content: progress || bullet([`Aufgekommen in ${ctx.sourceLink ?? 'einer Quelle'}`]), source: ctx.sourceLink, visibility: null },
            confidence: 0.85,
          })
          linkTitle('quest', q.title)
          continue
        }
        const note = v.readNote(qid)
        if (!note) continue
        linkTitle('quest', note.title)
        if (progress)
          ops.push({
            op: 'append_block',
            note_id: note.id,
            note_title: note.title,
            block: { key: `${ctx.sourceKey}:progress`, heading: 'Fortschritt', content: progress, source: ctx.sourceLink, visibility: null },
            confidence: id ? 1 : similar!.score,
          })
        const curStatus = stripLink(note.frontmatter.status)
        if (q.status && norm(curStatus ?? '') !== norm(q.status)) {
          ops.push({
            op: 'update_quest',
            note_id: note.id,
            note_title: note.title,
            field: 'status',
            from: curStatus,
            to: q.status,
            confidence: 0.7,
            reason: `Quest laut ${ctx.sourceLink ?? 'Quelle'} „${q.status}“`,
          })
        }
      }
    }

    // Beziehungen zwischen den Einträgen (Questgeber, Ziel, Aufenthaltsort …)
    this.planRelations(v, ex, resolutions, ops, ctx)

    // Gesetzte Fakten (eine Sammelnotiz je Kampagne)
    const factType = v.config.types.fact
    if (factType && ex.facts.length) {
      const title = factType.single_note ?? 'Gesetzte Fakten'
      const id = v.resolveName(title, { type: 'fact', campaign: ctx.campaign })
      const groups = { players: ex.facts.filter((f) => f.visibility !== 'dm'), dm: ex.facts.filter((f) => f.visibility === 'dm') }
      let created = false
      for (const [vis, facts] of Object.entries(groups)) {
        if (!facts.length) continue
        const block: BlockSpec = {
          key: vis === 'dm' ? `${ctx.sourceKey}:facts:dm` : `${ctx.sourceKey}:facts`,
          heading: 'Fakten',
          content: bullet(facts.map((f) => f.text)),
          source: ctx.sourceLink,
          visibility: vis === 'dm' ? 'dm' : null,
        }
        if (!id && !created) {
          const fm: Record<string, any> = {}
          if (ctx.campaign) fm.campaign = ctx.campaign
          fm.visibility = 'players'
          ops.push({ op: 'create_entity', type: 'fact', title, campaign: ctx.campaign, frontmatter: fm, block, confidence: 1 })
          created = true
        } else {
          ops.push({ op: 'append_block', note_id: id ?? undefined, note_title: title, type: 'fact', campaign: ctx.campaign, block, confidence: 1 })
        }
      }
    }

    // Verknüpfungen in der Quellnotiz (macht Backlinks sichtbar); DM-Einträge in einem eigenen DM-Bereich
    const src = ctx.sourceNoteId ? v.readNote(ctx.sourceNoteId) : null
    if (src) {
      const lines = (m: Map<string, string[]>) =>
        [...m.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([type, titles]) => `- **${v.typeDef(type).label ?? type}:** ${titles.map((t) => `[[${t}]]`).join(', ')}`)
          .join('\n')
      for (const [map, key, vis] of [
        [titlesByType, `${ctx.sourceKey}:links`, null],
        [dmTitlesByType, `${ctx.sourceKey}:links:dm`, 'dm'],
      ] as const) {
        if (!map.size) continue
        ops.push({
          op: 'append_block',
          note_id: src.id,
          note_title: src.title,
          block: { key, heading: 'Verknüpfte Einträge', content: lines(map), source: null, visibility: vis },
          confidence: 1,
        })
      }
    }

    // Automatisch oder Vorschlag?
    for (const op of ops) {
      op.auto = ctx.mode === 'auto' && cfg.auto_apply.includes(op.op) && !cfg.review.includes(op.op) && op.confidence >= cfg.min_confidence_auto
    }
    return ops
  }

  /**
   * Beziehungen als Abschnitt „Beziehungen“ in beide beteiligten Notizen schreiben und passende Eigenschaften
   * setzen (neue Einträge direkt, bestehende nur als Vorschlag und nur, wenn das Feld noch leer ist).
   */
  private planRelations(
    v: Vault,
    ex: Extraction,
    resolutions: Resolution[],
    ops: Operation[],
    ctx: { sourceKey: string; sourceLink: string | null; campaign: string | null; forceDm?: boolean },
  ) {
    if (!ex.relations?.length) return
    interface Target {
      title: string
      type: string
      id: string | null
      create: Operation | null
      dm: boolean
      frontmatter: Record<string, any>
      /** Raum innerhalb dieses Ortes (Überschrift im Abschnitt „Räume“) */
      anchor?: string
      /** Bei Räumen: der Ort, in dessen Notiz geschrieben wird */
      parent?: Target
    }
    const creates = new Map(ops.filter((o) => o.op === 'create_entity' && o.title).map((o) => [norm(o.title!), o]))
    const byName = new Map<string, Target>()
    ex.entities.forEach((e, i) => {
      const r = resolutions[i]
      const note = r.match !== 'new' ? v.readNote(r.match) : null
      const create = note ? null : (creates.get(norm(e.name)) ?? null)
      if (!note && !create) return
      const t: Target = {
        title: note?.title ?? e.name,
        type: note?.type ?? create?.type ?? e.type,
        id: note?.id ?? null,
        create,
        dm: !!ctx.forceDm || (e.visibility === 'dm' && !e.facts.length),
        frontmatter: note?.frontmatter ?? create?.frontmatter ?? {},
      }
      for (const n of [e.name, ...e.mentioned_as, t.title]) byName.set(norm(n), t)
      for (const room of e.rooms ?? []) {
        const rt: Target = { ...t, anchor: roomHeading(room.name), parent: t }
        for (const k of roomKeys(room.name)) if (!byName.has(k)) byName.set(k, rt)
      }
    })
    for (const q of ex.quests) {
      const id = v.resolveName(q.title, { type: 'quest', campaign: ctx.campaign })
      const note = id ? v.readNote(id) : null
      const create = note ? null : (creates.get(norm(q.title)) ?? null)
      if (!note && !create) continue
      byName.set(norm(q.title), {
        title: note?.title ?? q.title,
        type: 'quest',
        id: note?.id ?? null,
        create,
        dm: !!ctx.forceDm,
        frontmatter: note?.frontmatter ?? create?.frontmatter ?? {},
      })
    }
    const lookup = (name: string): Target | undefined => {
      const hit = byName.get(norm(name))
      if (hit) return hit
      // Bereits vorhandene Einträge, die in diesem Text nicht als Entität erkannt wurden
      const id = v.resolveName(name, { campaign: ctx.campaign })
      const n = id ? v.readNote(id) : null
      if (!n || NON_ENTITY_TYPES.has(n.type) && n.type !== 'quest') return undefined
      const t: Target = { title: n.title, type: n.type, id: n.id, create: null, dm: n.visibility === 'dm', frontmatter: n.frontmatter }
      byName.set(norm(name), t)
      return t
    }

    const FIELD: Partial<Record<ExRelation['kind'], string>> = { giver: 'giver', location: 'location', member: 'faction', owner: 'owner', parent: 'parent' }
    const lines = new Map<Target, { players: string[]; dm: string[] }>()
    const roomLines = new Map<Target, Map<string, { line: string; dm: boolean }[]>>()
    const add = (target: Target, line: string, dm: boolean) => {
      if (target.anchor && target.parent) {
        const rooms = roomLines.get(target.parent) ?? new Map<string, { line: string; dm: boolean }[]>()
        rooms.set(target.anchor, [...(rooms.get(target.anchor) ?? []), { line, dm }])
        roomLines.set(target.parent, rooms)
        return
      }
      const t = target.parent ?? target
      const l = lines.get(t) ?? { players: [], dm: [] }
      ;(dm ? l.dm : l.players).push(line)
      lines.set(t, l)
    }
    const ref = (t: Target) => (t.anchor ? `[[${t.title}#${t.anchor}]]` : `[[${t.title}]]`)
    for (const r of ex.relations) {
      const a = lookup(r.from)
      const b = lookup(r.to)
      if (!a || !b || a === b || (a.title === b.title && !a.anchor && !b.anchor)) continue
      // Raum ↔ eigener Ort ist schon durch den Abschnitt „Räume“ abgebildet
      if ((a.parent ?? a) === (b.parent ?? b)) continue
      const dm = a.dm || b.dm || r.visibility === 'dm'
      // Gegenstände „wohnen“ nicht irgendwo
      const itemPlace = r.kind === 'location' && a.type === 'item'
      add(a, `${itemPlace ? 'Fundort' : r.label}: ${ref(b)}`, dm)
      add(b, `${itemPlace ? 'Fundstück' : r.inverse}: ${ref(a)}`, dm)

      // Passende Eigenschaft (z. B. Quest → giver, Monster → location)
      const field = FIELD[r.kind]
      if (!field) continue
      for (const [side, other] of [
        [a, b],
        [b, a],
      ] as const) {
        const def = (v.typeDef(side.type).properties ?? []).find((p) => p.name === field)
        if (!def || (def.link_types && !def.link_types.includes(other.type))) continue
        if (r.kind === 'parent' && side !== a) continue
        if (side.anchor) continue
        const value = ref(other)
        if (side.create) {
          side.create.frontmatter = { ...(side.create.frontmatter ?? {}) }
          if (!side.create.frontmatter[field]) side.create.frontmatter[field] = value
        } else if (side.id && !stripLink(side.frontmatter[field]) && !ops.some((o) => o.op === 'update_property' && o.note_id === side.id && o.field === field)) {
          ops.push({
            op: 'update_property',
            note_id: side.id,
            note_title: side.title,
            field,
            from: null,
            to: value,
            confidence: 0.85,
            reason: `${ctx.sourceLink ?? 'Quelle'}: ${r.label} von „${side.title}“ ist „${other.title}“`,
          })
        }
        break
      }
    }

    // Zeilen zu Räumen direkt unter die Überschrift des Raums im Abschnitt „Räume“
    for (const [parent, rooms] of roomLines) {
      const blocks = [
        ...(parent.create?.extra_blocks ?? []),
        ...ops.filter((o) => o.op === 'append_block' && o.note_id && o.note_id === parent.id).map((o) => o.block!),
      ].filter((b) => /:rooms(:dm)?$/.test(b.key))
      for (const [anchor, entries] of rooms) {
        for (const { line, dm } of entries) {
          const block = blocks.find((b) => (dm ? b.visibility === 'dm' : true) && b.content.includes(`### ${anchor}\n`))
          if (block) block.content = addUnderRoom(block.content, anchor, line)
          else {
            const l = lines.get(parent) ?? { players: [], dm: [] }
            ;(dm ? l.dm : l.players).push(`${anchor} – ${line}`)
            lines.set(parent, l)
          }
        }
      }
    }

    // Link-Eigenschaften auf die tatsächlichen Titel (bzw. Räume) zeigen lassen
    for (const op of ops) {
      if (op.op !== 'create_entity' || !op.frontmatter) continue
      for (const p of v.typeDef(op.type!).properties ?? []) {
        // Werte mit Anker (Raum) sind schon exakt
        if (p.type !== 'link' || p.name === 'campaign' || !op.frontmatter[p.name] || String(op.frontmatter[p.name]).includes('#')) continue
        const t = lookup(stripLink(op.frontmatter[p.name]) ?? '')
        if (t) op.frontmatter[p.name] = ref(t)
      }
    }

    for (const [t, l] of lines) {
      for (const [list, key, vis] of [
        [l.players, `${ctx.sourceKey}:rel`, null],
        [l.dm, `${ctx.sourceKey}:rel:dm`, 'dm'],
      ] as const) {
        if (!list.length) continue
        const block: BlockSpec = { key, heading: 'Beziehungen', content: bullet(uniq(list, norm)), source: ctx.sourceLink, visibility: vis }
        if (t.create) t.create.extra_blocks = [...(t.create.extra_blocks ?? []), block]
        else if (t.id) ops.push({ op: 'append_block', note_id: t.id, note_title: t.title, block, confidence: 0.9 })
      }
    }
  }

  // ============================================================ 4. Anwenden

  /** Vorschau einer Operation: Pfad + Inhalt vorher/nachher (für Diffs). */
  preview(v: Vault, op: Operation): { path: string; before: string; after: string } {
    if (op.op === 'create_entity') {
      const existing = v.resolveName(op.title!, { type: op.type, campaign: op.campaign ?? null }) ?? v.resolveName(op.title!, { type: op.type })
      if (existing) return this.preview(v, { ...op, op: 'append_block', note_id: existing })
      const fm = { type: op.type, title: op.title, ...(op.frontmatter ?? {}) }
      const folder = v.folderFor(op.type!, op.campaign ?? null, op.title!)
      let body = v.templateBody(v.typeDef(op.type!).template, { title: op.title!, date: nowIso().slice(0, 10), campaign: op.campaign ?? '', type: op.type! })
      if (op.block) body = setBlock(body, { ...op.block, updated: nowIso().slice(0, 16) })
      for (const b of op.extra_blocks ?? []) body = setBlock(body, { ...b, updated: nowIso().slice(0, 16) })
      return { path: `${folder ? folder + '/' : ''}${op.title}.md`, before: '', after: composeNote(stringifyFrontmatter(fm), body) }
    }
    const id = op.note_id ?? (op.op === 'append_block' && op.note_title ? v.resolveName(op.note_title, { type: op.type, campaign: op.campaign ?? null }) : null)
    const note = id ? v.readNote(id) : null
    if (!note) {
      if (op.op === 'append_block' && op.type) return this.preview(v, { ...op, op: 'create_entity', title: op.note_title, frontmatter: { campaign: op.campaign ?? undefined } })
      throw notFound('Notiz')
    }
    const p = parseNote(note.raw)
    let after = note.raw
    switch (op.op) {
      case 'append_block':
      case 'add_mention':
        after = composeNote(p.fmText, setBlock(p.body, { ...op.block!, updated: nowIso().slice(0, 16) }))
        break
      case 'add_alias':
        after = composeNote(mergeFrontmatterText(p.fmText, { aliases: uniq([...note.aliases, op.alias!], norm) }), p.body)
        break
      case 'update_property':
      case 'update_quest':
      case 'contradiction':
        after = op.field ? composeNote(mergeFrontmatterText(p.fmText, { [op.field]: op.to }), p.body) : note.raw
        break
      case 'merge_entities': {
        const other = v.readNote(op.other_id!)
        if (!other) throw notFound('Notiz')
        const m = mergePlan(note, other)
        let body = p.body
        for (const b of m.blocks) body = setBlock(body, b)
        after = composeNote(mergeFrontmatterText(p.fmText, m.frontmatter), body)
        break
      }
      case 'delete':
        after = ''
        break
      case 'link_mentions':
        after = composeNote(p.fmText, this.linkedBody(v, note.id, p.body, op.links ?? []).body)
        break
    }
    return { path: note.path, before: note.raw, after }
  }

  diff(v: Vault, op: Operation): string {
    try {
      const pv = this.preview(v, op)
      return createTwoFilesPatch(pv.before ? `a/${pv.path}` : '/dev/null', `b/${pv.path}`, pv.before, pv.after, '', '', { context: 3 })
    } catch (e) {
      return `# Vorschau nicht möglich: ${(e as Error).message}`
    }
  }

  /** Eine Operation ausführen. Gibt zurück, ob etwas angelegt (created) oder geändert (updated) wurde. */
  async apply(v: Vault, op: Operation, wo: { silent: boolean; commitMessage?: string }): Promise<{ created?: string; updated?: string; skipped?: string }> {
    switch (op.op) {
      case 'create_entity': {
        const existing = v.resolveName(op.title!, { type: op.type, campaign: op.campaign ?? null }) ?? v.resolveName(op.title!, { type: op.type })
        if (existing) {
          if (op.block) await v.putBlock(existing, op.block, wo)
          for (const b of op.extra_blocks ?? []) await v.putBlock(existing, b, wo)
          return { updated: existing }
        }
        const note = await v.createNote({ type: op.type, title: op.title!, frontmatter: op.frontmatter }, wo)
        if (op.block) await v.putBlock(note.id, op.block, wo)
        for (const b of op.extra_blocks ?? []) await v.putBlock(note.id, b, wo)
        return { created: note.id }
      }
      case 'append_block':
      case 'add_mention': {
        let id = op.note_id ?? (op.note_title ? v.resolveName(op.note_title, { type: op.type, campaign: op.campaign ?? null }) : null)
        if (!id && op.type && op.note_title) {
          const n = await v.createNote({ type: op.type, title: op.note_title, frontmatter: op.campaign ? { campaign: op.campaign, visibility: 'players' } : {} }, wo)
          id = n.id
        }
        if (!id || !v.readNote(id)) return { skipped: 'Notiz nicht gefunden' }
        await v.putBlock(id, op.block!, wo)
        return { updated: id }
      }
      case 'add_alias': {
        const note = v.readNote(op.note_id!)
        if (!note) return { skipped: 'Notiz nicht gefunden' }
        if (note.aliases.some((a) => norm(a) === norm(op.alias!)) || norm(note.title) === norm(op.alias!)) return { skipped: 'Alias vorhanden' }
        await v.patchNote(note.id, { frontmatter: { aliases: [...note.aliases, op.alias!] } }, undefined, wo)
        return { updated: note.id }
      }
      case 'update_property':
      case 'update_quest':
      case 'contradiction': {
        const note = v.readNote(op.note_id!)
        if (!note) return { skipped: 'Notiz nicht gefunden' }
        if (op.field) await v.patchNote(note.id, { frontmatter: { [op.field]: op.to } }, undefined, wo)
        return { updated: note.id }
      }
      case 'merge_entities': {
        const keep = v.readNote(op.note_id!)
        const other = v.readNote(op.other_id!)
        if (!keep || !other) return { skipped: 'Notiz nicht gefunden' }
        const m = mergePlan(keep, other)
        if (Object.keys(m.frontmatter).length) await v.patchNote(keep.id, { frontmatter: m.frontmatter }, undefined, wo)
        for (const b of m.blocks) await v.putBlock(keep.id, b, wo)
        await v.retargetLinks(other.id, keep.title, wo)
        await v.deleteNote(other.id, wo)
        return { updated: keep.id }
      }
      case 'delete': {
        if (!op.note_id || !v.readNote(op.note_id)) return { skipped: 'Notiz nicht gefunden' }
        await v.deleteNote(op.note_id, wo)
        return { updated: op.note_id }
      }
      case 'link_mentions': {
        const note = op.note_id ? v.readNote(op.note_id) : null
        if (!note) return { skipped: 'Notiz nicht gefunden' }
        const p = parseNote(note.raw)
        const r = this.linkedBody(v, note.id, p.body, op.links ?? [])
        if (!r.linked.length) return { skipped: 'nichts mehr zu verknüpfen' }
        await v.replaceNote(note.id, { raw: composeNote(p.fmText, r.body) }, note.version, wo)
        return { updated: note.id }
      }
    }
    return { skipped: 'unbekannte Operation' }
  }

  // ============================================================ Lauf

  async run(input: CurateInput, signal?: AbortSignal): Promise<RunResult> {
    const v = this.vaults.get(input.vault)
    if (!v.config.curator.enabled && !input.dryRun) throw new ApiError('forbidden', 'Der Kurator ist für diesen Vault ausgeschaltet.')
    const runId = ulid()
    const created = nowIso()
    const src = input.sourceNoteId ? v.readNote(input.sourceNoteId) : null
    const sourceLink = src ? `[[${src.title}]]` : (input.sourceLabel ?? null)
    const campaign = input.campaign ?? src?.campaign ?? null
    this.db.run(
      'INSERT INTO runs (id, vault, source_key, inbox_id, note_id, campaign, mode, dry_run, status, input, created) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      runId,
      v.id,
      input.sourceKey,
      input.inboxId ?? null,
      src?.id ?? null,
      campaign,
      input.mode,
      input.dryRun ? 1 : 0,
      'running',
      input.text.slice(0, 200_000),
      created,
    )
    const progress: RunProgress = {
      run_id: runId,
      vault: v.id,
      inbox_id: input.inboxId ?? null,
      source_key: input.sourceKey,
      title: src?.title ?? input.sourceLabel ?? input.sourceKey,
      dry_run: !!input.dryRun,
      phase: 'Erkennen',
      step: 0,
      steps: 0,
      tokens: 0,
      started: created,
    }
    this.progress.set(runId, progress)
    const check = () => {
      if (signal?.aborted) throw new CancelledError()
    }
    try {
      check()
      // Menschliche Änderungen vorher separat sichern, damit „Lauf rückgängig“ nur den Kurator trifft
      if (!input.dryRun) await v.flushCommit()
      const linkOnly = v.config.curator.mode === 'link'
      let ops: Operation[]
      if (linkOnly) {
        // Nur verknüpfen: kein LLM, nur die Quell-Notiz bekommt Links auf vorhandene Notizen
        const op = src ? this.linkOp(v, src.id, input.mode === 'auto') : null
        ops = op ? [op] : []
        this.db.run('UPDATE runs SET extraction = ?, plan = ?, llm = ? WHERE id = ?', JSON.stringify({ mode: 'link', links: op?.links ?? [] }), JSON.stringify(ops), JSON.stringify({ mode: 'link' }), runId)
      } else {
      // Vorbereitungs-Skripte beschreiben Geplantes – nichts davon ist schon passiert oder den Spielern bekannt
      const isScript = src?.type === 'script'
      const hint = isScript
        ? '- WICHTIG: Der Text ist ein Vorbereitungs-Skript der Spielleitung. Beschreibe Figuren, Orte, Monster und Gegenstände sachlich in normalen Sätzen (wer/was sie sind, was sie wollen, was sie tun). Nur Handlungen der Gruppe, die erst noch passieren sollen, als geplant kennzeichnen ("Die Gruppe soll …"). Quests haben den Status "offen". Berufe und Rollen ("Schmiedin", "Koboldmagier") gehören in properties.role, nicht in "mentioned_as".'
        : ''
      const forceDm = input.forceDm || isScript
      const { extraction, chunks, model, context, warnings } = await this.extract(
        v,
        input.text,
        campaign,
        hint,
        signal,
        (i, n) => {
          progress.step = i
          progress.steps = n
          progress.tokens = 0
        },
        (t) => (progress.tokens = t),
      )
      if (forceDm) {
        for (const e of extraction.entities) {
          e.dm_facts = [...e.facts, ...e.dm_facts]
          e.facts = []
          e.visibility = 'dm'
        }
        for (const f of extraction.facts) f.visibility = 'dm'
        for (const r of extraction.relations) r.visibility = 'dm'
      }
      foldRooms(extraction)
      const resolutions: Resolution[] = []
      progress.phase = 'Abgleichen'
      progress.tokens = 0
      progress.steps = extraction.entities.length
      for (const [i, e] of extraction.entities.entries()) {
        check()
        progress.step = i + 1
        resolutions.push(await this.resolveEntity(v, e, campaign, signal))
      }
      // Letzte Gelegenheit zum Abbrechen – ab hier wird geschrieben (kurz und am Stück)
      check()
      progress.phase = 'Anwenden'
      progress.step = 0
      progress.steps = 0
      const exclude = this.playerNames(v, src?.frontmatter, campaign)
      ops = this.plan(v, extraction, resolutions, {
        sourceKey: input.sourceKey,
        sourceLink,
        sourceNoteId: src?.id,
        campaign,
        mode: input.mode,
        exclude,
        playersText: forceDm ? '' : (input.playersText ?? input.text),
        forceDm,
      })
      const llmInfo = JSON.stringify({ model, context, chunks, ...(warnings.length ? { warnings } : {}) })
      this.db.run('UPDATE runs SET extraction = ?, plan = ?, llm = ? WHERE id = ?', JSON.stringify({ ...extraction, resolutions }), JSON.stringify(ops), llmInfo, runId)
      }

      if (input.dryRun) {
        const withDiffs = ops.map((op) => ({ ...op, diff: this.diff(v, op) }))
        this.db.run("UPDATE runs SET status = 'planned', plan = ?, finished = ? WHERE id = ?", JSON.stringify(withDiffs), nowIso(), runId)
        return { run_id: runId, status: 'planned', created: 0, updated: 0, proposals: 0, operations: withDiffs, commit: null }
      }

      // Alte offene Vorschläge derselben Quelle sind überholt
      this.db.run(
        "UPDATE proposals SET status = 'superseded', resolved = ? WHERE vault = ? AND status = 'open' AND run_id IN (SELECT id FROM runs WHERE vault = ? AND source_key = ? AND id != ?)",
        nowIso(),
        v.id,
        v.id,
        input.sourceKey,
        runId,
      )

      const applied: any[] = []
      const touched = new Set<string>()
      let nCreated = 0
      let nUpdated = 0
      for (const op of ops.filter((o) => o.auto)) {
        try {
          const r = await this.apply(v, op, { silent: true })
          if (r.created) nCreated++
          if (r.updated) nUpdated++
          const nid = r.created ?? r.updated
          if (nid && op.block) touched.add(`${nid}|${op.block.key}`)
          for (const b of op.extra_blocks ?? []) if (nid) touched.add(`${nid}|${b.key}`)
          applied.push({ op: op.op, title: op.title ?? op.note_title, note_id: nid ?? null, result: r.skipped ? `übersprungen: ${r.skipped}` : r.created ? 'angelegt' : 'aktualisiert' })
        } catch (e) {
          applied.push({ op: op.op, title: op.title ?? op.note_title, error: (e as Error).message })
        }
      }
      // Beiträge derselben Quelle, die nicht mehr vorkommen, entfernen (nur bei automatischen Läufen)
      if (input.mode === 'auto' && !linkOnly) {
        const keys = curatorKeys(input.sourceKey)
        const rows = this.db.all<{ note_id: string; key: string }>(`SELECT note_id, key FROM blocks WHERE vault = ? AND key IN (${keys.map(() => '?').join(',')})`, v.id, ...keys)
        for (const r of rows) {
          if (touched.has(`${r.note_id}|${r.key}`)) continue
          // Blöcke, die per Vorschlag kommen würden, nicht entfernen
          if (ops.some((o) => !o.auto && o.block?.key === r.key && o.note_id === r.note_id)) continue
          if (await v.deleteBlock(r.note_id, r.key, { silent: true })) applied.push({ op: 'remove_block', note_id: r.note_id, key: r.key, result: 'entfernt (kommt nicht mehr vor)' })
        }
      }
      // Neu angelegte, ähnlich benannte Entitäten → Zusammenführen vorschlagen
      ops.push(...this.similarNewEntities(v, applied.filter((a) => a.result === 'angelegt' && a.note_id).map((a) => a.note_id as string)))
      this.db.run('UPDATE runs SET plan = ? WHERE id = ?', JSON.stringify(ops), runId)
      const label = src?.title ?? input.sourceLabel ?? ''
      const commit = applied.length ? await v.git.commitAll(`Kurator: ${input.sourceKey}${label ? ` (${label})` : ''}`) : null

      // Vorschläge anlegen
      let nProposals = 0
      for (const op of ops.filter((o) => !o.auto)) {
        const pid = ulid()
        this.db.run(
          'INSERT INTO proposals (id, vault, run_id, campaign, note_id, op, kind, title, reason, confidence, status, created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          pid,
          v.id,
          runId,
          campaign,
          op.note_id ?? null,
          JSON.stringify(op),
          op.op,
          proposalTitle(op),
          op.reason ?? null,
          op.confidence,
          'open',
          nowIso(),
        )
        nProposals++
        this.events.emit('proposal.created', v.id, { proposal_id: pid, run_id: runId, kind: op.op, title: proposalTitle(op), note_id: op.note_id ?? null })
      }
      // Ereignisse für geänderte Notizen
      for (const a of applied) if (a.note_id) this.events.emit(a.result === 'angelegt' ? 'note.created' : 'note.updated', v.id, { note_id: a.note_id, title: a.title, by: 'curator', run_id: runId })

      this.db.run("UPDATE runs SET status = 'done', applied = ?, commit_sha = ?, finished = ? WHERE id = ?", JSON.stringify(applied), commit, nowIso(), runId)
      return { run_id: runId, status: 'done', created: nCreated, updated: nUpdated, proposals: nProposals, operations: ops, commit }
    } catch (e) {
      if (isCancelled(e)) {
        this.db.run("UPDATE runs SET status = 'cancelled', error = 'Vom Benutzer abgebrochen.', finished = ? WHERE id = ?", nowIso(), runId)
        throw e instanceof CancelledError ? e : new CancelledError()
      }
      this.db.run("UPDATE runs SET status = 'error', error = ?, finished = ? WHERE id = ?", (e as Error).message, nowIso(), runId)
      throw e
    } finally {
      this.progress.delete(runId)
    }
  }

  // ============================================================ Nur verknüpfen

  linkedBody(v: Vault, noteId: string, body: string, only?: string[]): { body: string; linked: string[] } {
    return linkNoteBody(this.db, v.id, noteId, body, only)
  }

  linkOp(v: Vault, noteId: string, auto: boolean): Operation | null {
    const note = v.readNote(noteId)
    if (!note) return null
    const r = this.linkedBody(v, note.id, parseNote(note.raw).body)
    if (!r.linked.length) return null
    return {
      op: 'link_mentions',
      auto,
      confidence: 1,
      note_id: note.id,
      note_title: note.title,
      links: r.linked,
      reason: `Erwähnt: ${r.linked.join(', ')}`,
    }
  }

  /** Spielernamen aus Session und Kampagne – sie sind keine Aliasse von Figuren. */
  private playerNames(v: Vault, fm: Record<string, any> | undefined, campaign: string | null): Set<string> {
    const out = new Set<string>()
    const add = (list: unknown) => {
      if (!Array.isArray(list)) return
      for (const p of list) if (p && typeof p === 'object' && (p as any).player) out.add(norm(String((p as any).player)))
    }
    add(fm?.players)
    if (campaign) {
      const cid = v.resolveName(campaign, { type: 'campaign' })
      if (cid) add(v.readNote(cid)?.frontmatter.players)
    }
    return out
  }

  /**
   * Gerade angelegte Entitäten mit ähnlich klingenden Einträgen desselben Typs (neu oder bestehend, gleiche Kampagne)
   * → Zusammenführen als Vorschlag. Nie automatisch.
   */
  private similarNewEntities(v: Vault, ids: string[]): Operation[] {
    const created = ids.map((id) => v.readNote(id)).filter((n): n is NonNullable<typeof n> => !!n && !NON_ENTITY_TYPES.has(n.type))
    const ops: Operation[] = []
    const paired = new Set<string>()
    for (const a of created) {
      const others = this.db
        .all<{ id: string }>('SELECT id FROM notes WHERE vault = ? AND type = ? AND id != ? AND (campaign IS ? OR lower(campaign) = lower(?))', v.id, a.type, a.id, a.campaign, a.campaign ?? '')
        .map((r) => v.readNote(r.id))
        .filter((n): n is NonNullable<typeof n> => !!n)
      let best: { note: (typeof others)[number]; score: number } | null = null
      for (const b of others) {
        if (paired.has([a.id, b.id].sort().join('|'))) continue
        let sc = 0
        for (const x of [a.title, ...a.aliases]) for (const y of [b.title, ...b.aliases]) sc = Math.max(sc, nameSimilarity(x, y))
        if (sc >= 0.75 && (!best || sc > best.score)) best = { note: b, score: sc }
      }
      if (!best) continue
      const b = best.note
      paired.add([a.id, b.id].sort().join('|'))
      // Bestehende Notiz behalten, sonst die ausführlichere
      const [keep, other] = !ids.includes(b.id) ? [b, a] : a.body.length >= b.body.length ? [a, b] : [b, a]
      ops.push({
        op: 'merge_entities',
        auto: false,
        note_id: keep.id,
        note_title: keep.title,
        other_id: other.id,
        other_title: other.title,
        confidence: best.score,
        reason: `„${other.title}“ wurde neu angelegt und klingt wie „${keep.title}“ – vermutlich dieselbe Entität (Ähnlichkeit ${Math.round(best.score * 100)} %).`,
      })
    }
    return ops
  }

  // ============================================================ Duplikate (ohne LLM)

  /**
   * Vault nach Duplikaten durchsuchen und Zusammenführ-Vorschläge anlegen.
   * Paare, zu denen es schon einen Vorschlag gibt (auch abgelehnte), werden nicht erneut vorgeschlagen.
   */
  proposeDuplicates(vault: string, opts: { dryRun?: boolean; minScore?: number } = {}) {
    const v = this.vaults.get(vault)
    const pairs = findDuplicates(this.db, v.id, opts.minScore ?? 0.85)
    const pairKey = (a: string, b: string) => [a, b].sort().join('|')
    const known = new Set(
      this.db
        .all<{ op: string }>("SELECT op FROM proposals WHERE vault = ? AND kind = 'merge_entities'", v.id)
        .map((r) => json<Operation>(r.op, {} as Operation))
        .filter((o) => o.note_id && o.other_id)
        .map((o) => pairKey(o.note_id!, o.other_id!)),
    )
    const fresh = pairs.filter((p) => !known.has(pairKey(p.keep.id, p.other.id)))
    const out = fresh.map((p) => ({ keep: { id: p.keep.id, title: p.keep.title, type: p.keep.type }, other: { id: p.other.id, title: p.other.title, type: p.other.type }, score: p.score, reason: p.reason }))
    if (opts.dryRun) return { found: pairs.length, known: pairs.length - fresh.length, created: 0, pairs: out }
    for (const p of fresh) {
      const op: Operation = {
        op: 'merge_entities',
        auto: false,
        note_id: p.keep.id,
        note_title: p.keep.title,
        other_id: p.other.id,
        other_title: p.other.title,
        confidence: p.score,
        reason: `Duplikat-Suche: ${p.reason}`,
      }
      const pid = ulid()
      this.db.run(
        'INSERT INTO proposals (id, vault, run_id, campaign, note_id, op, kind, title, reason, confidence, status, created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        pid,
        v.id,
        null,
        p.keep.campaign,
        p.keep.id,
        JSON.stringify(op),
        op.op,
        proposalTitle(op),
        op.reason ?? null,
        op.confidence,
        'open',
        nowIso(),
      )
      this.events.emit('proposal.created', v.id, { proposal_id: pid, kind: op.op, title: proposalTitle(op), note_id: p.keep.id })
    }
    return { found: pairs.length, known: pairs.length - fresh.length, created: fresh.length, pairs: out }
  }

  // ============================================================ Vorschläge

  getProposal(vault: string, id: string) {
    const row = this.db.get<any>('SELECT * FROM proposals WHERE vault = ? AND id = ?', vault, id)
    if (!row) throw notFound('Vorschlag')
    return row
  }

  proposalJson(v: Vault, row: any, withDiff: boolean) {
    const op = json<Operation>(row.op, {} as Operation)
    return {
      id: row.id,
      vault: row.vault,
      run_id: row.run_id,
      campaign: row.campaign,
      note_id: row.note_id,
      kind: row.kind,
      title: row.title,
      reason: row.reason,
      confidence: row.confidence,
      status: row.status,
      created: row.created,
      resolved: row.resolved,
      operation: op,
      ...(withDiff && row.status === 'open' ? { diff: this.diff(v, op) } : {}),
    }
  }

  editProposal(vault: string, id: string, changes: Partial<Operation>) {
    const row = this.getProposal(vault, id)
    if (row.status !== 'open') throw new ApiError('conflict', 'Vorschlag ist nicht mehr offen.')
    const op = json<Operation>(row.op, {} as Operation)
    const allowed: (keyof Operation)[] = ['to', 'title', 'alias', 'field', 'frontmatter', 'type', 'note_id', 'other_id', 'reason']
    for (const k of allowed) if (k in changes) (op as any)[k] = (changes as any)[k]
    if (changes.block && op.block) op.block = { ...op.block, ...changes.block }
    this.db.run('UPDATE proposals SET op = ?, title = ?, note_id = ? WHERE id = ?', JSON.stringify(op), proposalTitle(op), op.note_id ?? null, id)
    return this.getProposal(vault, id)
  }

  async resolveProposal(vault: string, id: string, action: 'accept' | 'reject') {
    const v = this.vaults.get(vault)
    const row = this.getProposal(vault, id)
    if (row.status !== 'open') throw new ApiError('conflict', 'Vorschlag ist nicht mehr offen.')
    const op = json<Operation>(row.op, {} as Operation)
    let result: any = null
    if (action === 'accept') {
      result = await this.apply(v, op, { silent: false, commitMessage: `Vorschlag angenommen: ${row.title}` })
      await v.flushCommit()
    }
    const status = action === 'accept' ? 'accepted' : 'rejected'
    this.db.run('UPDATE proposals SET status = ?, resolved = ? WHERE id = ?', status, nowIso(), id)
    this.events.emit('proposal.resolved', v.id, { proposal_id: id, status, kind: row.kind, note_id: result?.created ?? result?.updated ?? row.note_id })
    return { id, status, result }
  }

  // ============================================================ Lauf rückgängig

  async revertRun(vault: string, runId: string) {
    const v = this.vaults.get(vault)
    const run = this.db.get<any>('SELECT * FROM runs WHERE vault = ? AND id = ?', vault, runId)
    if (!run) throw notFound('Lauf')
    if (run.reverted) throw new ApiError('conflict', 'Lauf wurde bereits rückgängig gemacht.')
    let commit: string | null = null
    let method: 'git' | 'semantic' | null = null
    if (run.commit_sha) {
      await v.flushCommit()
      const message = `Kurator-Lauf rückgängig: ${run.source_key}`
      const files = await v.git.changedFiles(run.commit_sha)
      try {
        commit = await v.git.revert(run.commit_sha, message)
        method = 'git'
        for (const f of files) if (v.isNotePath(f)) await v.indexFile(f)
      } catch {
        // Notizen wurden seitdem bearbeitet → nur die Beiträge des Laufs zurücknehmen
        commit = await this.semanticRevert(v, run.commit_sha, message)
        method = 'semantic'
      }
    }
    const discarded = this.db.run("UPDATE proposals SET status = 'discarded', resolved = ? WHERE run_id = ? AND status = 'open'", nowIso(), runId).changes
    this.db.run('UPDATE runs SET reverted = ?, status = ? WHERE id = ?', nowIso(), 'reverted', runId)
    this.events.emit('run.reverted', v.id, { run_id: runId, commit, discarded_proposals: Number(discarded) })
    return { run_id: runId, revert_commit: commit, method, discarded_proposals: Number(discarded) }
  }

  /**
   * Nimmt die Änderungen eines Kurator-Commits zurück, ohne spätere menschliche Änderungen anzutasten:
   * angelegte Notizen → Papierkorb, Bereiche → alter Inhalt bzw. entfernt, Eigenschaften → alter Wert
   * (nur, wenn sie seitdem nicht von Hand geändert wurden), hinzugefügte Listeneinträge (Aliasse) → entfernt.
   */
  private async semanticRevert(v: Vault, sha: string, message: string): Promise<string | null> {
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
    for (const c of await v.git.changes(sha)) {
      if (!v.isNotePath(c.path)) continue
      const after = await v.git.fileAt(sha, c.path)
      if (after === null) continue
      const pa = parseNote(after)
      const id = pa.frontmatter.id ? String(pa.frontmatter.id) : v.idOfPath(c.path)
      const cur = id ? v.readNote(id) : null
      if (!cur) continue
      if (c.status === 'A') {
        await v.deleteNote(cur.id, { silent: true })
        continue
      }
      const before = await v.git.fileAt(`${sha}^`, c.path)
      if (before === null) continue
      const pb = parseNote(before)
      const pc = parseNote(cur.raw)
      let body = pc.body
      const oldBlocks = new Map(listBlocks(pb.body).map((b) => [b.key, b]))
      for (const b of listBlocks(pa.body)) {
        const old = oldBlocks.get(b.key)
        if (old && old.content === b.content) continue
        body = old
          ? setBlock(body, { key: b.key, content: old.content, source: old.attrs.source ?? null, visibility: old.attrs.visibility ?? null, updated: old.attrs.updated })
          : removeBlock(body, b.key).body
      }
      const fb = pb.frontmatter
      const fa = pa.frontmatter
      const fc = pc.frontmatter
      const changes: Record<string, any> = {}
      const remove: string[] = []
      for (const k of new Set([...Object.keys(fb), ...Object.keys(fa)])) {
        if (k === 'id' || k === 'updated' || same(fb[k], fa[k])) continue
        if (Array.isArray(fa[k]) && Array.isArray(fc[k]) && (fb[k] === undefined || Array.isArray(fb[k]))) {
          const added = fa[k].filter((x: unknown) => !(fb[k] ?? []).some((y: unknown) => same(x, y)))
          const next = fc[k].filter((x: unknown) => !added.some((y: unknown) => same(x, y)))
          if (next.length !== fc[k].length) {
            if (next.length) changes[k] = next
            else remove.push(k)
          }
          continue
        }
        if (!same(fc[k], fa[k])) continue
        if (fb[k] === undefined) remove.push(k)
        else changes[k] = fb[k]
      }
      const raw = composeNote(Object.keys(changes).length || remove.length ? mergeFrontmatterText(pc.fmText, changes, remove) : pc.fmText, body)
      if (raw !== cur.raw) await v.replaceNote(cur.id, { raw }, cur.version, { silent: true, touchUpdated: false })
    }
    return v.git.commitAll(`${message} (ohne spätere Änderungen)`)
  }
}

export function proposalTitle(op: Operation): string {
  const t = op.note_title ?? op.title ?? ''
  switch (op.op) {
    case 'create_entity':
      return `Neu anlegen: ${op.title} (${op.type})`
    case 'append_block':
      return `Beitrag ergänzen: ${t}`
    case 'add_mention':
      return `Erwähnung: ${t}`
    case 'add_alias':
      return `Alias „${op.alias}“ für ${t}`
    case 'update_property':
      return `${t}: ${op.field} → ${op.to}`
    case 'update_quest':
      return `Quest ${t}: ${op.field} → ${op.to}`
    case 'contradiction':
      return `Widerspruch bei ${t}${op.field ? `: ${op.field}` : ''}`
    case 'merge_entities':
      return `Zusammenführen: ${op.other_title} → ${t}`
    case 'delete':
      return `Löschen: ${t}`
    case 'link_mentions':
      return `Verknüpfen in ${t}: ${(op.links ?? []).join(', ')}`
  }
  return t
}
