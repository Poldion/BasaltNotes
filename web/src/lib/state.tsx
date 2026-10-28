import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, setCsrf, withToken, type Me, type TypeSchema, type VaultInfo, type Features } from './api'
import { tr } from './i18n'

export type Theme = 'light' | 'dark' | 'auto'

interface Toast {
  id: number
  text: string
  kind: 'info' | 'error' | 'success'
}

interface AppState {
  me: Me | null
  setMe: (m: Me | null) => void
  vaults: VaultInfo[]
  refreshVaults: () => Promise<void>
  theme: Theme
  setTheme: (t: Theme) => void
  toast: (text: string, kind?: Toast['kind']) => void
  toasts: Toast[]
  embed: boolean
  canWrite: boolean
  isAdmin: boolean
  /** Spieler-Sicht: keine DM-Bereiche (Eingang, Vorschläge, Protokoll) */
  isPlayer: boolean
  /** Eingeschaltete Funktionen (KI-Kurator, KI-Chat) */
  features: Features
  /** Anmeldung/Funktionen neu laden (z. B. nach dem Umschalten) */
  refreshMe: () => Promise<void>
}

const Ctx = createContext<AppState>(null as any)

function readTheme(): Theme {
  try {
    const t = localStorage.getItem('basalt:theme')
    if (t === 'light' || t === 'dark' || t === 'auto') return t
  } catch {
    // kein Speicher
  }
  return 'auto'
}

export function applyTheme(t: Theme) {
  const root = document.documentElement
  if (t === 'auto') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', t)
}

export function AppProvider({ children, embed }: { children: ReactNode; embed: boolean }) {
  const [me, setMeState] = useState<Me | null>(null)
  const [vaults, setVaults] = useState<VaultInfo[]>([])
  const [theme, setThemeState] = useState<Theme>(() => {
    const p = new URLSearchParams(location.search).get('theme')
    return p === 'light' || p === 'dark' || p === 'auto' ? p : readTheme()
  })
  const [toasts, setToasts] = useState<Toast[]>([])
  const seq = useRef(0)

  useEffect(() => applyTheme(theme), [theme])

  const setMe = useCallback((m: Me | null) => {
    setCsrf(m?.csrf ?? null)
    setMeState(m)
  }, [])

  const refreshMe = useCallback(async () => {
    setMe(await api<Me>('/auth/me'))
  }, [setMe])

  const refreshVaults = useCallback(async () => {
    const r = await api<{ items: VaultInfo[] }>('/vaults')
    setVaults(r.items)
  }, [])

  const setTheme = useCallback(
    (t: Theme) => {
      setThemeState(t)
      if (!embed) {
        try {
          localStorage.setItem('basalt:theme', t)
        } catch {
          // ignorieren
        }
      }
    },
    [embed],
  )

  const toast = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = ++seq.current
    setToasts((ts) => [...ts, { id, text, kind }])
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 3500)
  }, [])

  const value = useMemo<AppState>(() => {
    const scopes = me?.scopes ?? []
    return {
      me,
      setMe,
      vaults,
      refreshVaults,
      theme,
      setTheme,
      toast,
      toasts,
      embed,
      canWrite: scopes.includes('write') || scopes.includes('admin'),
      isAdmin: scopes.includes('admin'),
      isPlayer: me?.visibility === 'players',
      features: me?.features ?? { curator: false, chat: false, setup_done: true },
      refreshMe,
    }
  }, [me, setMe, refreshMe, vaults, refreshVaults, theme, setTheme, toast, toasts, embed])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useApp() {
  return useContext(Ctx)
}

// ------------------------------------------------------------ Live-Ereignisse (SSE)

export interface BasaltEvent {
  event: string
  vault: string | null
  at: string
  data: Record<string, any>
}

type Listener = (e: BasaltEvent) => void
const listeners = new Map<string, Set<Listener>>()
const sources = new Map<string, EventSource>()

const EVENT_NAMES = [
  'note.created',
  'note.updated',
  'note.renamed',
  'note.deleted',
  'inbox.queued',
  'inbox.processed',
  'inbox.failed',
  'inbox.cancelled',
  'proposal.created',
  'proposal.resolved',
  'run.reverted',
]

function ensureSource(vault: string) {
  if (sources.has(vault)) return
  const es = new EventSource(withToken(`/api/v1/events?vault=${encodeURIComponent(vault)}`), { withCredentials: true })
  for (const name of EVENT_NAMES) {
    es.addEventListener(name, (msg) => {
      try {
        const e = JSON.parse((msg as MessageEvent).data) as BasaltEvent
        for (const l of listeners.get(vault) ?? []) l(e)
      } catch {
        // ignorieren
      }
    })
  }
  sources.set(vault, es)
}

/** Live-Ereignisse eines Vaults abonnieren. */
export function useVaultEvents(vault: string | undefined, fn: Listener) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (!vault) return
    ensureSource(vault)
    const l: Listener = (e) => ref.current(e)
    let set = listeners.get(vault)
    if (!set) listeners.set(vault, (set = new Set()))
    set.add(l)
    return () => {
      set!.delete(l)
    }
  }, [vault])
}

// ------------------------------------------------------------ Typen-Schema je Vault (Cache)

const typeCache = new Map<string, Promise<TypeSchema[]>>()

export function loadTypes(vault: string): Promise<TypeSchema[]> {
  let p = typeCache.get(vault)
  if (!p) {
    // Bezeichnungen der mitgelieferten Typen und Felder übersetzen (eigene bleiben, wie sie sind)
    p = api<{ items: TypeSchema[] }>(`/vaults/${encodeURIComponent(vault)}/types`).then((r) =>
      r.items.map((t) => ({ ...t, label: tr(t.label), properties: t.properties.map((pr) => ({ ...pr, label: tr(pr.label) })) })),
    )
    p.catch(() => typeCache.delete(vault))
    typeCache.set(vault, p)
  }
  return p
}

export function invalidateTypes(vault: string) {
  typeCache.delete(vault)
}

export function useTypes(vault: string | undefined): TypeSchema[] {
  const [types, setTypes] = useState<TypeSchema[]>([])
  useEffect(() => {
    if (!vault) return
    let alive = true
    loadTypes(vault)
      .then((t) => alive && setTypes(t))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [vault])
  return types
}

export function typeLabel(types: TypeSchema[], name: string): string {
  return types.find((t) => t.name === name)?.label ?? name
}
