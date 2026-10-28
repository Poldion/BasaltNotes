import { describe, expect, it } from 'vitest'
import { extractLinks, listBlocks, mergeFrontmatterText, parseNote, removeBlock, replaceLinks, setBlock, stripDmBlocks } from '../src/notes/markdown.js'
import { appendText } from '../src/notes/vault.js'

const NOTE = `---
id: 01JA8Z6K3P8Q2V9W4X5Y6Z7A8B   # stabil
type: npc
title: Zylia
aliases: [Cydia, Sylvia]
---

# Zylia

Eigener Text des DM … mit [[Barovia]] und [[Valerius|dem Händler]].

## Motive (DM)
Geheim.

## Aus den Sessions
`

describe('Frontmatter', () => {
  it('liest Frontmatter und Body byte-genau', () => {
    const p = parseNote(NOTE)
    expect(p.frontmatter.title).toBe('Zylia')
    expect(p.frontmatter.aliases).toEqual(['Cydia', 'Sylvia'])
    expect(p.body.startsWith('\n# Zylia')).toBe(true)
  })

  it('behält Kommentare beim Zusammenführen', () => {
    const p = parseNote(NOTE)
    const fm = mergeFrontmatterText(p.fmText, { status: 'tot' })
    expect(fm).toContain('# stabil')
    expect(fm).toContain('status: tot')
  })

  it('Notiz ohne Frontmatter', () => {
    const p = parseNote('# Nur Text\n')
    expect(p.fmText).toBeNull()
    expect(p.body).toBe('# Nur Text\n')
  })
})

describe('Links', () => {
  it('erkennt alle Link-Formen', () => {
    const links = extractLinks('A [[Zylia]] B [[Barovia|das Tal]] C [[Strahd#Motive]] D ![[karte.png]] `[[kein Link]]`')
    expect(links.map((l) => [l.target, l.heading, l.display, l.embed])).toEqual([
      ['Zylia', null, null, false],
      ['Barovia', null, 'das Tal', false],
      ['Strahd', 'Motive', null, false],
      ['karte.png', null, null, true],
    ])
  })

  it('ersetzt Links und behält Überschrift und Anzeigetext', () => {
    const r = replaceLinks('x [[Zylia]] y [[zylia#Motive|sie]] z [[Andere]]', (t) => t.toLowerCase() === 'zylia', 'Zylia die Weise')
    expect(r.count).toBe(2)
    expect(r.body).toBe('x [[Zylia die Weise]] y [[Zylia die Weise#Motive|sie]] z [[Andere]]')
  })
})

describe('Verwaltete Bereiche', () => {
  const body = parseNote(NOTE).body

  it('hängt neuen Bereich unter der Überschrift an, Text außerhalb bleibt byte-genau', () => {
    const out = setBlock(body, { key: 'whispernotes:job:1', heading: 'Aus den Sessions', content: '- Führt die Karawane.', source: '[[Session 1]]' })
    const blocks = listBlocks(out)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].content).toBe('- Führt die Karawane.')
    // Entfernen ergibt wieder exakt das Original
    expect(removeBlock(out, 'whispernotes:job:1').body.replace(/\n+$/, '\n')).toBe(body.replace(/\n+$/, '\n'))
    expect(out.startsWith(body.replace(/\n+$/, ''))).toBe(true)
  })

  it('gleicher Key ersetzt, neuer Key hängt an', () => {
    let out = setBlock(body, { key: 'a', heading: 'Aus den Sessions', content: 'eins' })
    out = setBlock(out, { key: 'b', heading: 'Aus den Sessions', content: 'zwei' })
    const before = out
    out = setBlock(out, { key: 'a', heading: 'Aus den Sessions', content: 'EINS' })
    expect(listBlocks(out).map((b) => [b.key, b.content])).toEqual([
      ['a', 'EINS'],
      ['b', 'zwei'],
    ])
    // nur der Bereich selbst hat sich geändert
    expect(out.length - before.length).toBe(0)
  })

  it('fügt Bereich mitten im Dokument ein, ohne folgende Abschnitte zu verändern', () => {
    const doc = '# T\n\n## A\nText A\n\n## B\nText B\n'
    const out = setBlock(doc, { key: 'k', heading: 'A', content: '- neu' })
    expect(out).toBe('# T\n\n## A\nText A\n<!-- basalt:block key="k" -->\n- neu\n<!-- /basalt:block -->\n\n## B\nText B\n')
  })

  it('legt fehlende Überschrift an', () => {
    const out = setBlock('# T\n\nText\n', { key: 'k', heading: 'Aus den Sessions', content: '- x' })
    expect(out).toContain('## Aus den Sessions\n<!-- basalt:block key="k" -->')
    expect(out.startsWith('# T\n\nText\n')).toBe(true)
  })

  it('entfernt DM-Bereiche für die Spieler-Sicht', () => {
    let out = setBlock(body, { key: 'p', heading: 'Aus den Sessions', content: 'offen' })
    out = setBlock(out, { key: 'd', heading: 'Aus den Sessions', content: 'geheim', visibility: 'dm' })
    const players = stripDmBlocks(out)
    expect(players).toContain('offen')
    expect(players).not.toContain('geheim')
  })

  it('Attribute mit Sonderzeichen', () => {
    const out = setBlock('', { key: 'x"y', content: 'z', source: '[[A "B"]]' })
    expect(listBlocks(out)[0].key).toBe('x"y')
    expect(listBlocks(out)[0].attrs.source).toBe('[[A "B"]]')
  })
})

describe('Anhängen', () => {
  it('unter Überschrift', () => {
    expect(appendText('# T\n\n## A\neins\n\n## B\n', 'zwei', 'A')).toBe('# T\n\n## A\neins\nzwei\n\n## B\n')
  })
  it('am Ende', () => {
    expect(appendText('Text', 'mehr')).toBe('Text\n\nmehr\n')
  })
})
