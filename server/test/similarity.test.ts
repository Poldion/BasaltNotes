import { describe, expect, it } from 'vitest'
import { koelnerPhonetik, nameSimilarity } from '../src/lib/similarity.js'
import { cleanVariants, roleFromVariants } from '../src/curator/curator.js'

describe('Kölner Phonetik', () => {
  it('Referenzbeispiel', () => {
    expect(koelnerPhonetik('Müller-Lüdenscheidt')).toBe('65752682')
    expect(koelnerPhonetik('Wikipedia')).toBe('3412')
  })
})

describe('Schreibvarianten aus Transkripten', () => {
  const same: [string, string][] = [
    ['Zylia', 'Cydia'],
    ['Zylia', 'Sylvia'],
    ['Zylia', 'Zyliya'],
    ['Drog Bo', 'Drogbo'],
    ['Drog Bo', 'Drogo'],
    ['Lyssara', 'Lusara'],
    ['Lyssara', 'Lyusara'],
    ['Valerius', 'Valerios'],
    ['Livia', 'Lyvia'],
  ]
  for (const [a, b] of same) {
    it(`${a} ≈ ${b}`, () => {
      expect(nameSimilarity(a, b)).toBeGreaterThanOrEqual(0.6)
    })
  }

  it('verschiedene Namen bleiben unter der Schwelle für automatische Zuordnung', () => {
    expect(nameSimilarity('Zylia', 'Valerius')).toBeLessThan(0.6)
    expect(nameSimilarity('Barovia', 'Lyssara')).toBeLessThan(0.6)
  })

  it('identisch = 1', () => {
    expect(nameSimilarity('Zylia', 'zylia')).toBe(1)
  })
})

describe('Alias-Bereinigung', () => {
  it('behält Schreibvarianten, verwirft Beschreibungen, Beugungen und Spielernamen', () => {
    expect(cleanVariants('Cydia', ['Karawanenführerin Cydia', 'Zylia', 'Cydia'])).toEqual(['Zylia'])
    expect(cleanVariants('Alchemist', ['Alchemisten'])).toEqual([])
    expect(cleanVariants('Lyssara', ['Lusara', 'Mara'], new Set(['mara']))).toEqual(['Lusara'])
    expect(cleanVariants('Drog Bo', ['Drogbo', 'Barden Drog Bo', 'Drogo'])).toEqual(['Drogbo', 'Drogo'])
    expect(cleanVariants('Valerius', ['Valerios'])).toEqual(['Valerios'])
  })
})

describe('Rollen statt Aliasse (Regarion)', () => {
  it('Beschreibungen werden keine Aliasse, sondern Rolle', () => {
    expect(cleanVariants('Fyrn Linstök', ['Kerzenzieher', 'Fyrn Linstök'])).toEqual([])
    expect(cleanVariants('Kefir', ['Koboldmagier', 'Kefir'])).toEqual([])
    expect(cleanVariants('Pepepe', ['Koboldwache im Schuppen'])).toEqual([])
    expect(roleFromVariants('Fyrn Linstök', ['Kerzenzieher', 'Fyrn Linstök'])).toBe('Kerzenzieher')
    expect(roleFromVariants('Pepepe', ['Koboldwache im Schuppen', 'Pepepe'])).toBe('Koboldwache im Schuppen')
    expect(roleFromVariants('Zylia', ['Cydia'])).toBeNull()
  })
  it('echte Schreibvarianten bleiben', () => {
    expect(cleanVariants('Meller Wraant', ['Meller'])).toEqual(['Meller'])
    expect(cleanVariants('Zylia', ['Cydia', 'Sylvia', 'Zyliya'])).toEqual(['Cydia', 'Sylvia', 'Zyliya'])
    expect(cleanVariants('Strahd von Zarovich', ['Strahd'])).toEqual(['Strahd'])
  })
})
