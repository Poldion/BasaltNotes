import type { ServerPlugin } from '@basaltnotes/plugin-sdk'
import { registerDav } from './dav.js'
import { setContext } from './h.js'
import { registerCalendar } from './routes.js'

/** Kalender & CalDAV – mitgeliefertes Plugin */
const plugin: ServerPlugin = {
  api(app, ctx) {
    setContext(ctx)
    registerCalendar(app, ctx)
  },
  root(app, ctx) {
    setContext(ctx)
    registerDav(app, ctx)
  },
}

export default plugin
