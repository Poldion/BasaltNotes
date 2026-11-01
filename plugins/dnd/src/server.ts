import type { ServerPlugin } from '@basaltnotes/plugin-sdk'
import { DND_PROFILE } from './profile.js'
import { DND_PRESET } from './preset.js'
import { registerCampaigns } from './routes.js'

/** D&D – Vorlage, Regelwerk, Kampagnen und Spieler-Sicht */
const plugin: ServerPlugin = {
  presets: [DND_PRESET],
  profiles: [DND_PROFILE],
  roles: [{ id: 'player', label: 'Spieler (nur Spieler-Inhalte)', scopes: ['read'], restricted: true }],
  api(app, ctx) {
    registerCampaigns(app, ctx)
  },
}

export default plugin
