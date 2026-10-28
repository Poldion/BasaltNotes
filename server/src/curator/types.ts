export interface ExEntity {
  name: string
  type: string
  mentioned_as: string[]
  summary: string
  facts: string[]
  /** Fakten nur für die Spielleitung (visibility: dm) */
  dm_facts: string[]
  properties: Record<string, string>
  visibility: 'dm' | 'players'
  confidence: number
  /** Räume/Bereiche innerhalb eines Ortes – werden Abschnitte statt eigener Notizen */
  rooms?: { name: string; description: string }[]
}

export interface ExQuest {
  title: string
  status: string
  giver: string | null
  summary: string
}

export const RELATION_KINDS = ['giver', 'target', 'location', 'member', 'owner', 'parent', 'ally', 'enemy', 'other'] as const
export type RelationKind = (typeof RELATION_KINDS)[number]

export interface ExRelation {
  /** Name einer Entität oder Titel einer Quest */
  from: string
  to: string
  kind: RelationKind
  /** Bezeichnung aus Sicht von `from`, z. B. „Questgeber“ */
  label: string
  /** Bezeichnung aus Sicht von `to`, z. B. „gibt Quest“ */
  inverse: string
  visibility: 'dm' | 'players'
}

export interface Extraction {
  entities: ExEntity[]
  events: { text: string; entities: string[] }[]
  quests: ExQuest[]
  facts: { text: string; visibility: 'dm' | 'players' }[]
  relations: ExRelation[]
}

export type OpKind =
  | 'create_entity'
  | 'append_block'
  | 'add_mention'
  | 'add_alias'
  | 'update_property'
  | 'contradiction'
  | 'merge_entities'
  | 'update_quest'
  | 'delete'
  | 'link_mentions'

export interface BlockSpec {
  key: string
  heading: string | null
  content: string
  source: string | null
  visibility: string | null
}

export interface Operation {
  op: OpKind
  /** Ausführung ohne Freigabe? */
  auto?: boolean
  confidence: number
  reason?: string
  note_id?: string
  note_title?: string
  // create_entity
  type?: string
  title?: string
  campaign?: string | null
  frontmatter?: Record<string, any>
  // append_block / add_mention / create_entity
  block?: BlockSpec
  /** weitere Bereiche beim Anlegen (z. B. DM-Wissen) */
  extra_blocks?: BlockSpec[]
  // add_alias
  alias?: string
  // update_property / contradiction / update_quest
  field?: string
  from?: any
  to?: any
  // merge_entities
  other_id?: string
  other_title?: string
  // link_mentions: Titel der Notizen, die verlinkt werden
  links?: string[]
}

export interface Resolution {
  name: string
  type: string
  match: string | 'new'
  title?: string
  confidence: number
  method: 'exact' | 'similar' | 'llm' | 'new'
  candidates: { id: string; title: string; score: number }[]
  reason?: string
  /** weitere bestehende Notiz, die vermutlich dieselbe Entität ist */
  duplicate_of?: { id: string; title: string; score: number }
}

export interface Plan {
  run_id: string
  source_key: string
  operations: Operation[]
}
