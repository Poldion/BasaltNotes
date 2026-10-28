/** Testmaterial nach dem Vorbild der WhisperNotes-Recaps (Kampagne „Tests“, Sessions vom 10./11.10.2026). */

export const SESSION1 = {
  source: { app: 'whispernotes', key: 'whispernotes:job:ab12cd34', url: 'http://whispernotes.local:8000/dashboard/#dnd' },
  note: {
    type: 'session',
    title: '2026-10-11 Session 1',
    frontmatter: {
      campaign: 'Tests',
      date: '2026-10-11T22:00:00+02:00',
      players: [
        { player: 'Robin', character: null, role: 'dm' },
        { player: 'Mara', character: 'Lyssara' },
      ],
      duration_seconds: 1728,
      transcript_url: 'http://whispernotes.local:8000/api/jobs/ab12cd34/transcript?format=md',
    },
    body: '## Was bisher geschah\nDie Karawane bricht von Valerius auf.\n## Ereignisse\nCydia bittet die Gruppe, den Streit zwischen Barde und Alchemist zu schlichten. Der Wagen bleibt im Sumpf stecken; ein Schleimmonster greift an.',
  },
  attachments: [
    { name: 'Spieler-Recaps', kind: 'players_recap', markdown: '## Lyssara (Mara)\nLusara schlichtet den Streit.' },
    { name: 'Welt & Lore', kind: 'lore', markdown: '## NPCs\nZylia verheimlicht ihre Herkunft.', visibility: 'dm' },
  ],
  curate: 'auto',
}

export const EXTRACTION1 = {
  entities: [
    {
      name: 'Zylia',
      type: 'npc',
      mentioned_as: ['Cydia', 'Zylia'],
      summary: 'Karawanenführerin',
      facts: ['Bittet die Gruppe, den Streit zwischen Barde und Alchemist zu schlichten', 'Belohnt die Schlichtung mit einer Extra-Ration'],
      properties: { role: 'Karawanenführerin', attitude: 'freundlich' },
      visibility: 'players',
      confidence: 0.9,
    },
    { name: 'Zylia', type: 'npc', mentioned_as: [], summary: '', facts: ['Verheimlicht ihre Herkunft'], properties: {}, visibility: 'dm', confidence: 0.85 },
    { name: 'Lyssara', type: 'character', mentioned_as: ['Lusara'], summary: 'Spielercharakter von Mara', facts: ['Schlichtet den Streit'], properties: { player: 'Mara' }, visibility: 'players', confidence: 0.95 },
    { name: 'Valerius', type: 'npc', mentioned_as: [], summary: 'Händler', facts: ['Startpunkt der Karawane'], properties: {}, visibility: 'players', confidence: 0.8 },
    { name: 'Schleimmonster', type: 'npc', mentioned_as: [], summary: 'Monster im Sumpf', facts: ['Greift die Gruppe im Sumpf an'], properties: { attitude: 'feindlich' }, visibility: 'players', confidence: 0.6 },
  ],
  events: [{ text: 'Wagen bleibt im Sumpf stecken; Schleimmonster greift an', entities: ['Schleimmonster'] }],
  quests: [{ title: 'Brücke über den Bach', status: 'offen', giver: 'Zylia', summary: 'Die Gruppe soll eine Brücke finden.' }],
  facts: [
    { text: 'Die Karawane fährt von Valerius nach Osten', visibility: 'players' },
    { text: 'Zylia stammt aus Barovia', visibility: 'dm' },
  ],
}

export const SESSION2 = {
  source: { app: 'whispernotes', key: 'whispernotes:job:ef56', url: 'http://whispernotes.local:8000/dashboard/#dnd' },
  note: {
    type: 'session',
    title: '2026-10-18 Session 2',
    frontmatter: { campaign: 'tests', date: '2026-10-18T22:00:00+02:00' },
    body: '## Ereignisse\nSylvia wird feindselig. Valerios verkauft Proviant. Die Brücke über den Bach ist gefunden.',
  },
  curate: 'auto',
}

export const EXTRACTION2 = {
  entities: [
    { name: 'Sylvia', type: 'npc', mentioned_as: ['Sylvia'], summary: '', facts: ['Wird der Gruppe gegenüber feindselig'], properties: { attitude: 'feindlich' }, visibility: 'players', confidence: 0.9 },
    { name: 'Valerios', type: 'npc', mentioned_as: ['Valerios'], summary: '', facts: ['Verkauft Proviant'], properties: {}, visibility: 'players', confidence: 0.9 },
  ],
  events: [],
  quests: [{ title: 'Brücke über den Bach', status: 'erledigt', giver: null, summary: 'Brücke gefunden.' }],
  facts: [],
}
