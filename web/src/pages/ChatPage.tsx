import { useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { api, apiStream, enc } from '../lib/api'
import { useApp } from '../lib/state'
import { Spinner, TypeDot } from '../lib/ui'
import { AnswerText } from '../lib/chatAnswer'
import { tr } from '../lib/i18n'

interface Source {
  id: string
  title: string
  type: string
  role: 'focus' | 'mention' | 'related' | 'list' | 'fulltext' | 'timeline'
  reason: string
  aliases?: string[]
  headings?: string[]
}

interface Msg {
  role: 'user' | 'assistant'
  content: string
  sources?: Source[]
  focus?: string[]
  context?: string
  chars?: number
  /** searching → waiting (hinter dem Kurator) → reading (LLM liest ein) → streaming → done */
  state?: 'searching' | 'waiting' | 'reading' | 'thinking' | 'streaming' | 'done' | 'error' | 'stopped'
  /** Nachdenken des Modells (falls in den Einstellungen eingeschaltet) */
  thinking?: string
  llm?: boolean
}

const ROLE_LABEL: Record<Source['role'], string> = {
  focus: tr('Hauptthema'),
  mention: tr('Erwähnt in'),
  related: tr('Verknüpft'),
  list: tr('Übersicht'),
  fulltext: tr('Fundstelle'),
  timeline: tr('Verlauf'),
}

const EXAMPLES = [tr('Was weiß ich über …?'), tr('Welche Quests sind offen?'), tr('Was ist in der letzten Session passiert?'), tr('Wo wohnt …?')]

const storeKey = (vault: string) => `basalt-chat:${vault}`

function loadMsgs(vault: string): Msg[] {
  try {
    const raw = sessionStorage.getItem(storeKey(vault))
    return raw ? (JSON.parse(raw) as Msg[]).map((m) => (m.state && m.state !== 'done' && m.state !== 'error' ? { ...m, state: 'stopped' } : m)) : []
  } catch {
    return []
  }
}

export function ChatPage() {
  const { vault = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const { me, toast } = useApp()
  const [msgs, setMsgs] = useState<Msg[]>(() => loadMsgs(vault))
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [campaigns, setCampaigns] = useState<string[]>([])
  const [campaign, setCampaign] = useState(params.get('campaign') ?? '')
  const [focus, setFocus] = useState<{ id: string; title: string; type: string } | null>(null)
  const ctrl = useRef<AbortController | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  /** Mitscrollen nur, solange man unten ist – wer hochscrollt, wird nicht zurückgezogen */
  const follow = useRef(true)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    setMsgs(loadMsgs(vault))
    api<{ items: { title: string }[] }>(`/vaults/${enc(vault)}/campaigns`)
      .then((r) => setCampaigns(r.items.map((c) => c.title)))
      .catch(() => setCampaigns([]))
  }, [vault])

  // „Fragen zu dieser Notiz“ aus der Notizansicht
  useEffect(() => {
    const id = params.get('focus')
    if (!id) return
    api<{ id: string; title: string; type: string }>(`/vaults/${enc(vault)}/notes/${enc(id)}?fields=title,type`)
      .then((n) => setFocus({ id: n.id, title: n.title, type: n.type }))
      .catch(() => setFocus(null))
    inputRef.current?.focus()
  }, [vault, params])

  useEffect(() => {
    try {
      sessionStorage.setItem(storeKey(vault), JSON.stringify(msgs.slice(-40)))
    } catch {
      // Speicher voll oder gesperrt
    }
  }, [vault, msgs])

  // Ende des Verlaufs liegt knapp über dem (klebenden) Eingabefeld, nicht dahinter
  const scrollToEnd = () => {
    const end = endRef.current
    const form = formRef.current
    if (!end) return
    end.style.scrollMarginBottom = `${(form?.offsetHeight ?? 0) + 16}px`
    end.scrollIntoView({ block: 'end' })
  }
  useEffect(() => {
    const end = endRef.current
    if (!end) return
    const container = end.closest('.main')
    const onScroll = () => {
      const formTop = formRef.current?.getBoundingClientRect().top ?? window.innerHeight
      follow.current = end.getBoundingClientRect().top - formTop < 140
    }
    container?.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      container?.removeEventListener('scroll', onScroll)
      window.removeEventListener('scroll', onScroll)
    }
  }, [])
  useEffect(() => {
    if (follow.current) scrollToEnd()
  }, [msgs])

  const update = (fn: (m: Msg) => Msg) => setMsgs((all) => [...all.slice(0, -1), fn(all[all.length - 1])])

  const ask = async (question: string) => {
    const q = question.trim()
    if (!q || busy) return
    const history = msgs.filter((m) => m.content && (m.role === 'user' || m.state === 'done')).map((m) => ({ role: m.role, content: m.content }))
    const previous = [...msgs].reverse().find((m) => m.role === 'assistant' && m.focus?.length)?.focus
    follow.current = true
    setMsgs((all) => [...all, { role: 'user', content: q }, { role: 'assistant', content: '', state: 'searching' }])
    setInput('')
    setBusy(true)
    const ac = new AbortController()
    ctrl.current = ac
    try {
      await apiStream(
        `/vaults/${enc(vault)}/chat`,
        { question: q, history, previous, focus: focus ? [focus.id] : undefined, campaign: campaign || null, stream: true, include_context: true },
        (event, data) => {
          if (event === 'context') update((m) => ({ ...m, sources: data.sources, focus: data.focus, context: data.context, chars: data.chars, state: 'waiting' }))
          else if (event === 'start') update((m) => ({ ...m, state: 'reading' }))
          else if (event === 'thinking') update((m) => ({ ...m, thinking: (m.thinking ?? '') + data.text, state: m.content ? m.state : 'thinking' }))
          else if (event === 'token') update((m) => ({ ...m, content: m.content + data.text, state: 'streaming' }))
          else if (event === 'done') update((m) => ({ ...m, content: data.answer || m.content, llm: data.llm, state: 'done' }))
          else if (event === 'error') update((m) => ({ ...m, content: data.message ?? tr('Fehler'), state: 'error' }))
        },
        ac.signal,
      )
    } catch (e) {
      if (ac.signal.aborted) update((m) => ({ ...m, state: 'stopped' }))
      else {
        update((m) => ({ ...m, content: (e as Error).message, state: 'error' }))
        toast((e as Error).message, 'error')
      }
    } finally {
      setBusy(false)
      ctrl.current = null
    }
  }

  const reset = () => {
    ctrl.current?.abort()
    setMsgs([])
    setFocus(null)
    if (params.get('focus')) {
      params.delete('focus')
      setParams(params, { replace: true })
    }
  }

  const restricted = !!me?.campaign

  return (
    <div className="page chat-page">
      <div className="page-header">
        <h1>{tr('Fragen an die Notizen')}</h1>
        {!restricted && campaigns.length > 0 && (
          <select className="input" style={{ width: 'auto' }} value={campaign} onChange={(e) => setCampaign(e.target.value)} aria-label={tr('Kampagne')}>
            <option value="">{tr('Alle Kampagnen')}</option>
            {campaigns.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
        {msgs.length > 0 && (
          <button className="btn small" onClick={reset} disabled={busy}>
            {tr('Neuer Chat')}
          </button>
        )}
      </div>

      <div className="chat-log">
        {msgs.length === 0 && (
          <div className="empty stack" style={{ gap: 10 }}>
            <div>
              {tr('Stell eine Frage zu deinen Notizen. Passende Einträge werden vorher ohne LLM herausgesucht, nur diese bekommt das Modell zu sehen.')}
            </div>
            <div className="row" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
              {EXAMPLES.map((e) => (
                <button key={e} className="btn small ghost" onClick={() => (setInput(e.replace(' …', ' ')), inputRef.current?.focus())}>
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="chat-msg user">
              {m.content}
            </div>
          ) : (
            <div key={i} className="chat-msg assistant card">
              {m.state === 'searching' && (
                <div className="row small muted">
                  <Spinner /> {tr('Suche passende Notizen …')}
                </div>
              )}
              {m.state === 'waiting' && (
                <div className="row small muted">
                  <Spinner /> {tr('Warte auf das LLM (läuft gerade der Kurator, kommt die Frage danach dran) …')}
                </div>
              )}
              {m.state === 'reading' && (
                <div className="row small muted">
                  <Spinner /> {tr('Das LLM liest')}{' '}{m.chars ? tr('{x}k Zeichen', { x: Math.round(m.chars / 100) / 10 }) : tr('die Notizen')} {tr('ein …')}
                </div>
              )}
              {m.state === 'thinking' && (
                <div className="row small muted">
                  <Spinner /> {tr('Das LLM denkt nach … (')}{(m.thinking ?? '').length} {tr('Zeichen)')}
                </div>
              )}
              {!!m.thinking && (
                <details className="chat-thinking" open={m.state === 'thinking'}>
                  <summary className="small faint">{tr('Gedanken des Modells ({length} Zeichen)', { length: m.thinking.length })}</summary>
                  <div className="chat-thinking-text">{m.thinking}</div>
                </details>
              )}
              {m.content && <AnswerText text={m.content} sources={m.sources ?? []} vault={vault} />}
              {m.state === 'stopped' && <div className="small faint">{tr('Abgebrochen.')}</div>}
              {m.state === 'error' && <div className="small" style={{ color: 'var(--danger)' }}>{tr('Die Antwort konnte nicht erzeugt werden.')}</div>}
              {!!m.sources?.length && (
                <details className="chat-sources">
                  <summary className="small muted">
                    {m.sources.length} {m.sources.length === 1 ? tr('Quelle') : tr('Quellen')}
                    {m.llm === false ? tr(' · ohne LLM beantwortet') : ''}
                  </summary>
                  <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                    {m.sources.map((s) => (
                      <Link key={s.id} to={`/${vault}/note/${enc(s.id)}`} className="chip" title={`${ROLE_LABEL[s.role]}: ${s.reason}`}>
                        <TypeDot type={s.type} /> {s.title}
                        <span className="faint" style={{ marginLeft: 4 }}>
                          {s.role === 'focus' ? '★' : ROLE_LABEL[s.role]}
                        </span>
                      </Link>
                    ))}
                  </div>
                  {m.context && (
                    <details style={{ marginTop: 8 }}>
                      <summary className="small faint">{tr('Was das LLM bekommen hat ({length} Zeichen)', { length: m.context.length })}</summary>
                      <pre className="chat-context">{m.context}</pre>
                    </details>
                  )}
                </details>
              )}
            </div>
          ),
        )}
        <div ref={endRef} />
      </div>

      <form
        ref={formRef}
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault()
          void ask(input)
        }}
      >
        {focus && (
          <div className="row small" style={{ marginBottom: 6 }}>
            <span className="muted">{tr('Fragen zu')}</span>
            <span className="chip accent">
              <TypeDot type={focus.type} /> {focus.title}
              <button type="button" className="btn ghost small" style={{ padding: '0 4px', minHeight: 0 }} onClick={() => setFocus(null)} aria-label={tr('Fokus entfernen')}>
                ×
              </button>
            </span>
          </div>
        )}
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <textarea
            ref={inputRef}
            className="input grow"
            rows={2}
            value={input}
            placeholder={focus ? tr('Frage zu {title} …', { title: focus.title }) : tr('Frage zu deinen Notizen …')}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void ask(input)
              }
            }}
          />
          {busy ? (
            <button type="button" className="btn danger" onClick={() => ctrl.current?.abort()}>
              {tr('Stopp')}
            </button>
          ) : (
            <button type="submit" className="btn primary" disabled={!input.trim()}>
              {tr('Fragen')}
            </button>
          )}
        </div>
        <div className="small faint" style={{ marginTop: 4 }}>
          {tr('Enter sendet, Umschalt+Enter für eine neue Zeile. Antworten stützen sich nur auf die gefundenen Notizen.')}
        </div>
      </form>
    </div>
  )
}
