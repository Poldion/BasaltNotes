import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as ReactRouterDom from 'react-router-dom'
import type { ComponentType } from 'react'
import { api, enc, qs } from './api'
import { useApp, useTypes, useVaultEvents } from './state'
import { Modal, Spinner, TypeDot, fmtDate, fmtDateTime, relTime, slugify } from './ui'
import { embedNavigate } from '../pages/NotePage'
import { addTranslations, lang, locale, tr, type Lang } from './i18n'
import { Icon } from '../components/Icon'

/*
 * Plugin-Host der Oberfläche: lädt die Oberflächen-Module eingeschalteter Plugins (ESM) und sammelt,
 * was sie registrieren (Seiten, Menüpunkte, Einstellungs-Karten). React, react-router-dom und die
 * App-Bausteine bekommen Plugins über globalThis.basalt – so benutzen sie dieselben Instanzen wie die App.
 */

export interface PluginInfo {
  id: string
  name: string
  version: string
  description: string | null
  author: string | null
  builtin: boolean
  repo: string | null
  enabled: boolean
  error: string | null
  web: string | null
  styles: string | null
}

export interface PluginPage {
  plugin: string
  path: string
  scope: 'vault' | 'global'
  component: ComponentType
  embed?: boolean
}

export interface PluginHomeSection {
  plugin: string
  id: string
  order?: number
  component: ComponentType<{ vault: string }>
}

export interface PluginNav {
  plugin: string
  id: string
  label: string
  icon?: string
  path: string
  order?: number
  visible?: (info: { vault: string; types: string[] }) => boolean
}

export interface PluginSettings {
  plugin: string
  id: string
  title?: string
  adminOnly?: boolean
  component: ComponentType
}

export const registry = {
  pages: [] as PluginPage[],
  nav: [] as PluginNav[],
  settings: [] as PluginSettings[],
  home: [] as PluginHomeSection[],
  loaded: [] as PluginInfo[],
  errors: {} as Record<string, string>,
}

/** Pfade, die der Kern selbst benutzt – Plugins dürfen sie nicht belegen */
const RESERVED = new Set(['note', 'search', 'chat', 'inbox', 'proposals', 'runs', 'graph', 'trash', 'settings', 'p'])

function expose() {
  ;(globalThis as any).basalt = {
    React,
    jsxRuntime,
    ReactRouterDom,
    sdk: { api, enc, qs, useApp, useTypes, useVaultEvents, Modal, Spinner, TypeDot, relTime, fmtDate, fmtDateTime, tr, lang, locale, Icon, embedNavigate, slugify },
  }
}

function contextFor(id: string) {
  return {
    id,
    registerPage(page: { path: string; scope?: 'vault' | 'global'; component: ComponentType; embed?: boolean }) {
      const path = page.path.replace(/^\/+|\/+$/g, '')
      if (!path || RESERVED.has(path.split('/')[0])) throw new Error(tr('Pfad „{path}“ ist nicht erlaubt', { path: page.path }))
      registry.pages.push({ plugin: id, path, scope: page.scope ?? 'vault', component: page.component, embed: page.embed })
    },
    registerHomeSection(section: Omit<PluginHomeSection, 'plugin'>) {
      registry.home.push({ ...section, plugin: id })
      registry.home.sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
    },
    registerNav(item: Omit<PluginNav, 'plugin'>) {
      registry.nav.push({ ...item, plugin: id, path: item.path.replace(/^\/+/, '') })
      registry.nav.sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
    },
    registerSettings(card: Omit<PluginSettings, 'plugin'>) {
      registry.settings.push({ ...card, plugin: id })
    },
    registerTranslations(l: Lang, dict: Record<string, string>) {
      addTranslations(l, dict)
    },
  }
}

let loading: Promise<void> | null = null

/** Eingeschaltete Plugins laden (einmal pro Seitenaufruf) */
export function loadPlugins(): Promise<void> {
  if (loading) return loading
  loading = (async () => {
    expose()
    let items: PluginInfo[] = []
    try {
      items = (await api<{ items: PluginInfo[] }>('/plugins')).items
    } catch {
      return
    }
    for (const p of items) {
      if (!p.enabled || !p.web) continue
      try {
        if (p.styles) {
          const link = document.createElement('link')
          link.rel = 'stylesheet'
          link.href = p.styles
          document.head.appendChild(link)
        }
        const mod = await import(/* @vite-ignore */ p.web)
        const activate = mod.default ?? mod.activate
        if (typeof activate !== 'function') throw new Error(tr('Kein activate() im Oberflächen-Modul'))
        activate(contextFor(p.id))
        registry.loaded.push(p)
      } catch (e) {
        registry.errors[p.id] = (e as Error).message
        console.error(`[plugin ${p.id}]`, e)
      }
    }
  })()
  return loading
}
