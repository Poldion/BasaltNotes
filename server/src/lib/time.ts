/** Zeitzone für Ortszeiten (TZ des Containers, sonst Europe/Berlin) */
export function timeZone(): string {
  const tz = process.env.TIMEZONE || process.env.TZ
  if (tz && tz !== 'UTC') {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz })
      return tz
    } catch {
      // ungültig
    }
  }
  return 'Europe/Berlin'
}

/** Versatz in Minuten einer Zeitzone zu einem UTC-Zeitpunkt */
function offsetAt(tz: string, utcMs: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, p.value]),
  )
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second))
  return Math.round((asUtc - utcMs) / 60000)
}

const pad = (n: number) => String(n).padStart(2, '0')

/** UTC-Zeitpunkt → Ortszeit mit Versatz "2026-11-03T09:30:00+01:00" */
export function utcToLocal(utcMs: number, tz = timeZone()): string {
  const off = offsetAt(tz, utcMs)
  const d = new Date(utcMs + off * 60000)
  const o = `${off >= 0 ? '+' : '-'}${pad(Math.trunc(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00${o}`
}
