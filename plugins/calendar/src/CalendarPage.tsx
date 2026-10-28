import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, enc, qs, useApp, useTypes, useVaultEvents, Modal, Spinner, TypeDot } from '@basaltnotes/plugin-sdk/web'
import { locale, tr } from '@basaltnotes/plugin-sdk/web'

interface CalItem {
  id: string
  note_id: string
  vault: string
  title: string
  type: string
  start: string
  end: string | null
  all_day: boolean
  location: string | null
  done: boolean | null
  status: string | null
  recurrence: string | null
  field: string
}

// Wochentage ab Montag und Monatsnamen in der Sprache der Oberfläche (5.1.2026 ist ein Montag)
const WEEKDAYS = Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2026, 0, 5 + i)).toLocaleDateString(locale, { weekday: 'short', timeZone: 'UTC' }).replace(/.$/, ''))
const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2026, i, 1)).toLocaleDateString(locale, { month: 'long', timeZone: 'UTC' }))

const pad = (n: number) => String(n).padStart(2, '0')
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00`)
  d.setDate(d.getDate() + n)
  return iso(d)
}
/** Ortszeit mit Zeitzonen-Versatz, wie die Eigenschaften-Felder speichern */
const withOffset = (local: string) => {
  const d = new Date(local)
  const off = -d.getTimezoneOffset()
  return `${local.length === 16 ? `${local}:00` : local}${off >= 0 ? '+' : '-'}${pad(Math.trunc(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
}
const timeOf = (s: string) => (s.length > 10 ? s.slice(11, 16) : null)

/** Liegt das Element an diesem Tag (auch mehrtägig)? */
function onDay(i: CalItem, day: string): boolean {
  const s = i.start.slice(0, 10)
  const e = (i.end ?? i.start).slice(0, 10)
  return s <= day && day <= (e < s ? s : e)
}

function dayLabel(day: string): string {
  const d = new Date(`${day}T12:00:00`)
  const today = iso(new Date())
  const rel = day === today ? tr('Heute') + ', ' : day === addDays(today, 1) ? tr('Morgen') + ', ' : ''
  return `${rel}${d.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' })}`
}

export function CalendarPage() {
  const { vault = '' } = useParams()
  const navigate = useNavigate()
  const { canWrite, toast, vaults } = useApp()
  const types = useTypes(vault)
  const today = iso(new Date())
  const [month, setMonth] = useState(() => today.slice(0, 7))
  const [view, setView] = useState<'month' | 'list'>(() => (window.innerWidth < 640 ? 'list' : 'month'))
  const [all, setAll] = useState(false)
  const [selected, setSelected] = useState(today)
  const [items, setItems] = useState<CalItem[] | null>(null)
  const [create, setCreate] = useState<string | null>(null)

  // Monatsraster: von Montag vor dem 1. bis Sonntag nach dem Monatsende
  const grid = useMemo(() => {
    const first = new Date(`${month}-01T12:00:00`)
    const startOffset = (first.getDay() + 6) % 7
    const start = addDays(`${month}-01`, -startOffset)
    const days: string[] = []
    for (let i = 0; i < 42; i++) days.push(addDays(start, i))
    while (days.length > 35 && days[days.length - 7].slice(0, 7) !== month) days.splice(-7)
    return days
  }, [month])

  const range = view === 'month' ? { from: grid[0], to: grid[grid.length - 1] } : { from: today, to: addDays(today, 60) }

  const load = useCallback(() => {
    const url = all ? `/calendar${qs(range)}` : `/vaults/${enc(vault)}/calendar${qs(range)}`
    api<{ items: CalItem[] }>(url)
      .then((r) => setItems(r.items))
      .catch((e) => {
        setItems([])
        toast((e as Error).message, 'error')
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault, all, range.from, range.to])
  useEffect(load, [load])
  useVaultEvents(vault, (e) => {
    if (e.event.startsWith('note.')) load()
  })

  const canCreate = canWrite && types.some((t) => t.name === 'event')
  const vaultName = (id: string) => vaults.find((v) => v.id === id)?.name ?? id
  const shift = (n: number) => {
    const d = new Date(`${month}-01T12:00:00`)
    d.setMonth(d.getMonth() + n)
    setMonth(iso(d).slice(0, 7))
  }

  const toggleDone = async (i: CalItem) => {
    try {
      await api(`/vaults/${enc(i.vault)}/notes/${enc(i.note_id)}`, { method: 'PATCH', body: { frontmatter: { status: i.done ? 'offen' : 'erledigt' } } })
      load()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const Entry = ({ i, compact }: { i: CalItem; compact?: boolean }) => (
    <div className={`cal-item ${i.done ? 'done' : ''}`} title={`${i.title}${i.location ? ` – ${i.location}` : ''}`}>
      {i.done !== null && !compact && (
        <input type="checkbox" checked={!!i.done} onChange={() => void toggleDone(i)} aria-label={tr('Erledigt')} disabled={!canWrite} />
      )}
      <TypeDot type={i.type} />
      {timeOf(i.start) && <span className="cal-time">{timeOf(i.start)}</span>}
      <Link to={`/${i.vault}/note/${enc(i.note_id)}`} className="cal-title" onClick={(e) => e.stopPropagation()}>
        {i.title}
      </Link>
      {!compact && i.end && timeOf(i.end) && <span className="faint small">{tr('bis')}{' '}{timeOf(i.end)}</span>}
      {!compact && i.location && <span className="faint small">· {i.location}</span>}
      {!compact && i.recurrence && <span className="faint small" title={tr('Wiederholt sich {recurrence}', { recurrence: tr(i.recurrence) })}>↻</span>}
      {!compact && all && <span className="chip" style={{ fontSize: 11 }}>{vaultName(i.vault)}</span>}
    </div>
  )

  const dayItems = (day: string) => (items ?? []).filter((i) => onDay(i, day))
  const listDays = useMemo(() => {
    const days = new Set<string>()
    for (const i of items ?? []) {
      let d = i.start.slice(0, 10) < range.from ? range.from : i.start.slice(0, 10)
      const end = (i.end ?? i.start).slice(0, 10)
      for (let n = 0; n < 60 && d <= end && d <= range.to; n++, d = addDays(d, 1)) days.add(d)
    }
    return [...days].sort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items])

  return (
    <div className="page calendar-page">
      <div className="page-header">
        <h1>{tr('Kalender')}</h1>
        <label className="row small" title={tr('Termine aller Notizbücher anzeigen')}>
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> {tr('alle Notizbücher')}
        </label>
        <div className="tabs">
          <button className={view === 'month' ? 'active' : ''} onClick={() => setView('month')}>
            {tr('Monat')}
          </button>
          <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>
            {tr('Liste')}
          </button>
        </div>
        {canCreate && (
          <button className="btn primary small" onClick={() => setCreate(selected)}>
            {tr('+ Termin')}
          </button>
        )}
      </div>

      {view === 'month' && (
        <>
          <div className="row" style={{ marginBottom: 8 }}>
            <button className="btn small" onClick={() => shift(-1)} aria-label={tr('Vorheriger Monat')}>
              ‹
            </button>
            <strong style={{ minWidth: 150, textAlign: 'center' }}>
              {MONTHS[Number(month.slice(5, 7)) - 1]} {month.slice(0, 4)}
            </strong>
            <button className="btn small" onClick={() => shift(1)} aria-label={tr('Nächster Monat')}>
              ›
            </button>
            <button className="btn small ghost" onClick={() => (setMonth(today.slice(0, 7)), setSelected(today))}>
              {tr('Heute')}
            </button>
            {items === null && <Spinner />}
          </div>
          <div className="cal-grid">
            {WEEKDAYS.map((w) => (
              <div key={w} className="cal-head">
                {w}
              </div>
            ))}
            {grid.map((day) => {
              const its = dayItems(day)
              return (
                <div
                  key={day}
                  className={`cal-day ${day.slice(0, 7) !== month ? 'other' : ''} ${day === today ? 'today' : ''} ${day === selected ? 'selected' : ''}`}
                  onClick={() => setSelected(day)}
                  onDoubleClick={() => canCreate && setCreate(day)}
                >
                  <div className="cal-num">{Number(day.slice(8))}</div>
                  {its.slice(0, 3).map((i) => (
                    <Entry key={i.id} i={i} compact />
                  ))}
                  {its.length > 3 && <div className="small faint">{tr('+{x} weitere', { x: its.length - 3 })}</div>}
                </div>
              )
            })}
          </div>
          <div className="card" style={{ marginTop: 12 }}>
            <div className="row" style={{ marginBottom: 6 }}>
              <strong className="grow">{dayLabel(selected)}</strong>
              {canCreate && (
                <button className="btn small" onClick={() => setCreate(selected)}>
                  {tr('+ Termin an diesem Tag')}
                </button>
              )}
            </div>
            {dayItems(selected).length ? dayItems(selected).map((i) => <Entry key={i.id} i={i} />) : <div className="small faint">{tr('Nichts eingetragen.')}</div>}
          </div>
        </>
      )}

      {view === 'list' &&
        (items === null ? (
          <Spinner />
        ) : listDays.length === 0 ? (
          <div className="empty">{tr('In den nächsten 60 Tagen steht nichts an.')}</div>
        ) : (
          <div className="stack">
            {listDays.map((day) => (
              <div key={day} className="card">
                <div className={`small ${day === today ? '' : 'muted'}`} style={{ fontWeight: 600, marginBottom: 4 }}>
                  {dayLabel(day)}
                </div>
                {dayItems(day).map((i) => (
                  <Entry key={i.id} i={i} />
                ))}
              </div>
            ))}
          </div>
        ))}

      {create && (
        <NewEvent
          vault={vault}
          date={create}
          onClose={() => setCreate(null)}
          onCreated={() => {
            setCreate(null)
            load()
            toast(tr('Termin angelegt'), 'success')
          }}
          onOpen={(id) => navigate(`/${vault}/note/${enc(id)}`)}
        />
      )}
    </div>
  )
}

/** Neuen Termin anlegen (Typ „Termin“) */
function NewEvent({ vault, date, onClose, onCreated, onOpen }: { vault: string; date: string; onClose: () => void; onCreated: () => void; onOpen: (id: string) => void }) {
  const { toast } = useApp()
  const [title, setTitle] = useState('')
  const [allDay, setAllDay] = useState(false)
  const [day, setDay] = useState(date)
  const [endDay, setEndDay] = useState(date)
  const [from, setFrom] = useState('18:00')
  const [to, setTo] = useState('19:00')
  const [location, setLocation] = useState('')
  const [recurrence, setRecurrence] = useState('keine')
  const [busy, setBusy] = useState(false)

  const save = async (open: boolean) => {
    if (!title.trim()) return
    setBusy(true)
    try {
      const frontmatter: Record<string, any> = allDay
        ? { start: day, ...(endDay > day ? { end: endDay } : {}), all_day: true }
        : { start: withOffset(`${day}T${from}`), ...(to ? { end: withOffset(`${to < from ? addDays(day, 1) : day}T${to}`) } : {}) }
      if (location.trim()) frontmatter.location = location.trim()
      if (recurrence !== 'keine') frontmatter.recurrence = recurrence
      const n = await api<{ id: string }>(`/vaults/${enc(vault)}/notes`, { body: { type: 'event', title: title.trim(), frontmatter } })
      if (open) onOpen(n.id)
      else onCreated()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={tr('Neuer Termin')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={() => void save(true)} disabled={busy || !title.trim()}>
            {tr('Anlegen und öffnen')}
          </button>
          <button className="btn primary" onClick={() => void save(false)} disabled={busy || !title.trim()}>
            {tr('Anlegen')}
          </button>
        </>
      }
    >
      <div className="modal-body stack">
        <label className="field">
          <span>{tr('Titel')}</span>
          <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save(false)} placeholder={tr('z. B. Zahnarzt')} />
        </label>
        <label className="row small">
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> {tr('ganztägig')}
        </label>
        <div className="grid-2">
          <label className="field">
            <span>{allDay ? tr('Von') : tr('Datum')}</span>
            <input className="input" type="date" value={day} onChange={(e) => (setDay(e.target.value), endDay < e.target.value && setEndDay(e.target.value))} />
          </label>
          {allDay ? (
            <label className="field">
              <span>{tr('Bis')}</span>
              <input className="input" type="date" value={endDay} min={day} onChange={(e) => setEndDay(e.target.value)} />
            </label>
          ) : (
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <label className="field grow">
                <span>{tr('Beginn')}</span>
                <input className="input" type="time" value={from} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label className="field grow">
                <span>{tr('Ende')}</span>
                <input className="input" type="time" value={to} onChange={(e) => setTo(e.target.value)} />
              </label>
            </div>
          )}
        </div>
        <label className="field">
          <span>{tr('Ort')}</span>
          <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} />
        </label>
        <label className="field">
          <span>{tr('Wiederholung')}</span>
          <select className="input" value={recurrence} onChange={(e) => setRecurrence(e.target.value)}>
            {['keine', 'täglich', 'wöchentlich', 'monatlich', 'jährlich'].map((r) => (
              <option key={r} value={r}>
                {tr(r)}
              </option>
            ))}
          </select>
        </label>
      </div>
    </Modal>
  )
}
