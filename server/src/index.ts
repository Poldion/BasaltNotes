import { buildApp } from './app.js'

async function main() {
  const { app, services, generatedPassword } = await buildApp()
  const { config } = services
  if (generatedPassword) {
    app.log.warn('==============================================================')
    app.log.warn(`Erster Start: Admin-Zugang  Benutzer „${config.admin.username}“  Passwort: ${generatedPassword}`)
    app.log.warn('Bitte nach dem Anmelden unter Einstellungen ändern (oder ADMIN_PASSWORD setzen).')
    app.log.warn('==============================================================')
  }
  const shutdown = async (signal: string) => {
    app.log.info(`${signal} empfangen, fahre herunter …`)
    await app.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  await app.listen({ port: config.port, host: config.host })
  // Ohne KI-Funktionen wird das LLM gar nicht erst angefragt
  const ai = config.features?.curator || config.features?.chat
  const info = ai ? await services.llm.info().catch(() => null) : null
  app.log.info(`BasaltNotes ${services.version} läuft – Daten: ${config.dataDir}${ai ? '' : ' (KI-Funktionen aus)'}`)
  if (info) app.log.info(`LLM ${info.url}: ${info.reachable ? `Modell ${info.model}, Kontext ${info.context} (${info.context_source})` : `nicht erreichbar (${info.error ?? '–'})`}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
