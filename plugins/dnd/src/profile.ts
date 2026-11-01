import type { VaultProfile } from '@basaltnotes/plugin-sdk'

/** Regelwerk für D&D-Vaults: Erkennung, Eingang, Chat */
export const DND_PROFILE: VaultProfile = {
  id: 'dnd',
  nonEntityTypes: ['session', 'campaign', 'lore', 'script'],
  entityRank: ['character', 'npc', 'monster', 'person', 'faction', 'location', 'item'],
  scoped: true,
  restrictedView: true,
  defaultInboxType: 'session',
  chatSubject: 'den Notizen einer Pen-&-Paper-Kampagne (D&D)',
  typeWords: {
    quest: ['quest', 'quests', 'aufgabe', 'aufgaben', 'auftrag', 'aufträge', 'mission', 'missionen'],
    npc: ['npc', 'npcs', 'person', 'personen', 'leute', 'figur', 'figuren', 'nsc', 'nscs'],
    character: ['charakter', 'charaktere', 'spielercharakter', 'spielercharaktere', 'held', 'helden', 'gruppe', 'party'],
    location: ['gegend', 'gegenden', 'dorf', 'dörfer', 'dungeon', 'dungeons'],
    monster: ['monster', 'kreatur', 'kreaturen', 'gegner', 'feind', 'feinde'],
    item: ['gegenstand', 'gegenstände', 'item', 'items', 'beute', 'loot', 'schatz', 'schätze', 'waffe', 'waffen', 'artefakt', 'artefakte'],
    faction: ['fraktion', 'fraktionen', 'gilde', 'gilden', 'gruppierung', 'gruppierungen', 'orden'],
    session: ['session', 'sessions', 'sitzung', 'sitzungen', 'spielabend', 'spielabende'],
    script: ['skript', 'skripte', 'vorbereitung', 'vorbereitungen'],
  },
  genericWords: ['kampagne', 'kampagnen', 'skript', 'recap', 'recaps'],

  systemPrompt({ group, types, hasType, knownNames, hint }) {
    return [
        `Du bist der Archivar einer D&D-Kampagne${group ? ` („${group}“)` : ''}. Lies den Text und gib NUR JSON nach dem Schema zurück.`,
        `- Erkenne Entitäten der Typen: ${types}. Spielercharaktere sind "character", benannte Personen und ansprechbare Figuren "npc"${hasType('monster') ? ', Gegner, Bestien und Kreaturen ohne eigene Rolle als Person (z. B. Schleim, Zombies, Wölfe) "monster"' : ''}.`,
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
  },

  // Vorbereitungs-Skripte beschreiben Geplantes – nichts davon ist schon passiert oder den Spielern bekannt
  sourceRules(note) {
    if (note.type !== 'script') return null
    return {
      restricted: true,
      hint: '- WICHTIG: Der Text ist ein Vorbereitungs-Skript der Spielleitung. Beschreibe Figuren, Orte, Monster und Gegenstände sachlich in normalen Sätzen (wer/was sie sind, was sie wollen, was sie tun). Nur Handlungen der Gruppe, die erst noch passieren sollen, als geplant kennzeichnen ("Die Gruppe soll …"). Quests haben den Status "offen". Berufe und Rollen ("Schmiedin", "Koboldmagier") gehören in properties.role, nicht in "mentioned_as".',
    }
  },

  // Spielernamen aus Session und Kampagne sind keine Aliasse von Figuren
  excludedNames({ v, frontmatter, group }) {
    const out: string[] = []
    const add = (list: unknown) => {
      if (!Array.isArray(list)) return
      for (const p of list) if (p && typeof p === 'object' && (p as any).player) out.push(String((p as any).player))
    }
    add(frontmatter?.players)
    if (group) {
      const cid = v.resolveName(group, { type: 'campaign' })
      if (cid) add(v.readNote(cid)?.frontmatter.players)
    }
    return out
  },

  // Kampagne per Name zuordnen (Groß-/Kleinschreibung, Kurzform) und bei Bedarf anlegen
  async resolveGroup({ v, db, slugify, name }) {
    if (!name || !v.config.types.campaign) return name ?? null
    const clean = String(name).replace(/^\[\[|\]\]$/g, '').trim()
    if (!clean) return null
    const id = v.resolveName(clean, { type: 'campaign' })
    if (id) return v.readNote(id)?.title ?? clean
    const all = db.all<{ title: string }>("SELECT title FROM notes WHERE vault = ? AND type = 'campaign'", v.id)
    const hit = all.find((c) => slugify(c.title) === slugify(clean))
    if (hit) return hit.title
    const n = await v.createNote({ type: 'campaign', title: clean, frontmatter: { status: 'aktiv', visibility: 'players' } })
    return n.title
  },

  inboxFrontmatter({ v, db, type, group, frontmatter: fm, isNew }) {
    if (fm.visibility === undefined) fm.visibility = 'players'
    if (isNew && type === 'session' && group && (fm.number === undefined || fm.number === null)) {
      const count = db.get<{ n: number }>("SELECT COUNT(*) n FROM notes WHERE vault = ? AND type = 'session' AND lower(campaign) = lower(?)", v.id, group)?.n ?? 0
      fm.number = count + 1
    }
  },

  // Hochgeladene Dokumente: standardmäßig nur für die Spielleitung
  documentDefaults({ v, visibility }) {
    return { type: ['script', 'lore'].find((t) => v.config.types[t]) ?? 'note', visibility: visibility ?? 'dm' }
  },
}
