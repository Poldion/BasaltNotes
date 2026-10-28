/** Ähnlichkeit von Schreibweisen: Jaro-Winkler, Levenshtein und Kölner Phonetik. */

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

export function levenshteinRatio(a: string, b: string): number {
  const max = Math.max(a.length, b.length)
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max
}

export function jaroWinkler(s1: string, s2: string): number {
  if (s1 === s2) return 1
  if (!s1.length || !s2.length) return 0
  const range = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1)
  const m1 = new Array(s1.length).fill(false)
  const m2 = new Array(s2.length).fill(false)
  let matches = 0
  for (let i = 0; i < s1.length; i++) {
    const lo = Math.max(0, i - range)
    const hi = Math.min(i + range + 1, s2.length)
    for (let j = lo; j < hi; j++) {
      if (m2[j] || s1[i] !== s2[j]) continue
      m1[i] = m2[j] = true
      matches++
      break
    }
  }
  if (!matches) return 0
  let t = 0
  let k = 0
  for (let i = 0; i < s1.length; i++) {
    if (!m1[i]) continue
    while (!m2[k]) k++
    if (s1[i] !== s2[k]) t++
    k++
  }
  const jaro = (matches / s1.length + matches / s2.length + (matches - t / 2) / matches) / 3
  let prefix = 0
  for (let i = 0; i < Math.min(4, s1.length, s2.length); i++) {
    if (s1[i] === s2[i]) prefix++
    else break
  }
  return jaro + prefix * 0.1 * (1 - jaro)
}

/** Kölner Phonetik (für deutsche Namen). */
export function koelnerPhonetik(input: string): string {
  const s = input
    .toUpperCase()
    .replace(/Ä/g, 'A')
    .replace(/Ö/g, 'O')
    .replace(/Ü/g, 'U')
    .replace(/ß/g, 'S')
    .normalize('NFKD')
    .replace(/[^A-Z]/g, '')
  if (!s) return ''
  const codes: string[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    const prev = i > 0 ? s[i - 1] : '#'
    const next = i < s.length - 1 ? s[i + 1] : '#'
    let code = ''
    if ('AEIJOUY'.includes(c)) code = '0'
    else if (c === 'H') code = '-'
    else if (c === 'B') code = '1'
    else if (c === 'P') code = next === 'H' ? '3' : '1'
    else if (c === 'D' || c === 'T') code = 'CSZ'.includes(next) ? '8' : '2'
    else if ('FVW'.includes(c)) code = '3'
    else if ('GKQ'.includes(c)) code = '4'
    else if (c === 'C') {
      if (i === 0) code = 'AHKLOQRUX'.includes(next) ? '4' : '8'
      else code = 'SZ'.includes(prev) ? '8' : 'AHKOQUX'.includes(next) ? '4' : '8'
    } else if (c === 'X') code = 'CKQ'.includes(prev) ? '8' : '48'
    else if (c === 'L') code = '5'
    else if (c === 'M' || c === 'N') code = '6'
    else if (c === 'R') code = '7'
    else if ('SZ'.includes(c)) code = '8'
    codes.push(code)
  }
  let out = ''
  let last = ''
  for (const code of codes) {
    if (code === '-') continue
    for (const ch of code) {
      if (ch !== last) out += ch
      last = ch
    }
  }
  return out[0] + out.slice(1).replace(/0/g, '')
}

function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .trim()
}

/** Gesamtwert 0..1 für zwei Schreibweisen eines Namens (auch gegen einzelne Wörter mehrteiliger Namen). */
export function nameSimilarity(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  // „Raum A“ vs. „Raum B“, „Wache 1“ vs. „Wache 2“: gleiche Namen mit anderem Kennzeichen sind verschiedene Dinge
  if (ta.length === tb.length && ta.length > 1) {
    const diff = ta.map((t, i) => [t, tb[i]] as const).filter(([x, y]) => x !== y)
    if (diff.length === 1 && diff[0].every((t) => t.length <= 2 || /^\d+$/.test(t))) return 0.1
  }
  if (fold(a) === fold(b)) return 1
  // Artikel/Füllwörter ignorieren: „Die Eber Jagd“ = „Eberjagd“
  const ca = core(a)
  const cb = core(b)
  if (ca.length && cb.length && ca.join('') === cb.join('')) return 0.98
  // Kurzform eines vollen Namens: „Fyrn“ → „Fyrn Linstök“, „Xal'Vroth“ → „Xal'Vroth, der Säure-Messias“
  if (isNamePrefix(a, b) || isNamePrefix(b, a)) return 0.93
  const whole = wholeSimilarity(a, b)
  // Einzelname gegen mehrteiligen Namen („Sylvia“ vs. „Zylia die Weise“): gegen die einzelnen Wörter prüfen.
  // Zwei mehrteilige Namen nur als Ganzes vergleichen – ein gemeinsames Wort („Raum“) macht sie nicht gleich.
  const wa = ta.filter((w) => w.length >= 4)
  const wb = tb.filter((w) => w.length >= 4)
  if (wa.length > 1 === wb.length > 1) return whole
  const single = wa.length > 1 ? fold(b) : fold(a)
  const words = wa.length > 1 ? wa : wb
  let best = 0
  for (const w of words) best = Math.max(best, wholeSimilarity(single, w))
  return Math.max(whole, Math.round(best * 0.9 * 1000) / 1000)
}

const STOPWORDS = new Set(['der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'eines', 'und', 'von', 'vom', 'zum', 'zur', 'the', 'a', 'an', 'of', 'and'])

/** Wörter eines Namens ohne Artikel/Füllwörter */
function core(s: string): string[] {
  return tokens(s).filter((t) => !STOPWORDS.has(t))
}

/**
 * Ist `short` der Anfang des Namens `long`? („Fyrn“ / „Fyrn Linstök“, „Valerius“ / „Valerius Vau“)
 * Nicht bei bloßem Kennzeichen dahinter („Wache“ / „Wache 2“).
 */
export function isNamePrefix(short: string, long: string): boolean {
  const s = core(short)
  const l = core(long)
  if (!s.length || s.length >= l.length || s.join('').length < 4) return false
  if (!s.every((t, i) => l[i] === t)) return false
  const rest = l.slice(s.length)
  if (rest.length === 1 && (rest[0].length <= 2 || /^\d+$/.test(rest[0]))) return false
  return true
}

function tokens(s: string): string[] {
  return fold(s.replace(/[-–_/.,:;()]+/g, ' ')).split(' ').filter(Boolean)
}

function wholeSimilarity(a: string, b: string): number {
  const x = fold(a)
  const y = fold(b)
  if (!x || !y) return 0
  if (x === y) return 1
  const jw = jaroWinkler(x, y)
  const lv = levenshteinRatio(x, y)
  const px = koelnerPhonetik(x)
  const py = koelnerPhonetik(y)
  const phon = px && py ? (px === py ? 1 : levenshteinRatio(px, py)) : 0
  // Leerzeichen-Varianten ("Drog Bo" vs. "Drogbo")
  const compact = x.replace(/ /g, '') === y.replace(/ /g, '') ? 1 : 0
  // Teilstring: "Valerius" in "Valerius der Händler"
  const contains = x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x)) ? 0.85 : 0
  const score = Math.max(compact * 0.98, contains, 0.45 * jw + 0.25 * lv + 0.3 * phon)
  return Math.round(score * 1000) / 1000
}
