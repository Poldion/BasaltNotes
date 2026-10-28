// Prüft die Übersetzungen: fehlende Einträge, ungenutzte Einträge und abweichende Platzhalter.
//   node scripts/i18n-check.mjs            Bericht
//   node scripts/i18n-check.mjs --strict   Exit-Code 1 bei fehlenden Übersetzungen (für die CI)
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const DIRS = ['web/src', 'plugins']
const LOCALES = path.join(root, 'web/src/locales')

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(tsx?|jsx?)$/.test(e.name) && e.name !== 'i18n.ts') out.push(p)
  }
  return out
}

// tr('…') mit einfachen Anführungszeichen (so schreibt sie der Code-Stil)
const used = new Map()
const re = /\btr\(\s*'((?:[^'\\]|\\.)*)'/g
const unescape = (s) => s.replace(/\\(.)/g, (_m, c) => (c === 'n' ? '\n' : c))
for (const d of DIRS) {
  for (const file of walk(path.join(root, d))) {
    const src = fs.readFileSync(file, 'utf8')
    for (const m of src.matchAll(re)) {
      const key = unescape(m[1])
      if (!used.has(key)) used.set(key, path.relative(root, file))
    }
  }
}

const vars = (s) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))
let missingTotal = 0
for (const f of fs.readdirSync(LOCALES).filter((x) => x.endsWith('.json'))) {
  const dict = JSON.parse(fs.readFileSync(path.join(LOCALES, f), 'utf8'))
  const missing = [...used.keys()].filter((k) => !dict[k])
  // Nicht im Code: Texte, die vom Server kommen (Typ- und Feldnamen, Rollen, Auswahlwerte) oder veraltete Einträge
  const unused = Object.keys(dict).filter((k) => !used.has(k))
  // Übersetzung darf Platzhalter weglassen (z. B. Pluralendungen), aber keine unbekannten verwenden
  const badVars = Object.entries(dict).filter(([k, v]) => [...vars(v)].some((x) => !vars(k).has(x)))
  missingTotal += missing.length
  console.log(`${f}: ${Object.keys(dict).length} Einträge, ${missing.length} fehlen, ${unused.length} nicht direkt im Code`)
  for (const k of missing) console.log(`  fehlt: ${JSON.stringify(k)}  (${used.get(k)})`)
  for (const [k, v] of badVars) console.log(`  Platzhalter weichen ab: ${JSON.stringify(k)} → ${JSON.stringify(v)}`)
}
if (process.argv.includes('--strict') && missingTotal) process.exit(1)
