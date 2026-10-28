import type { PluginHelpers, ServerPluginContext } from '@basaltnotes/plugin-sdk'

/** Kontext des Plugins – wird beim Laden gesetzt, damit alle Module dieselben Kern-Hilfen benutzen */
export let ctx: ServerPluginContext
export let H: PluginHelpers

export function setContext(c: ServerPluginContext) {
  ctx = c
  H = c.helpers
}
