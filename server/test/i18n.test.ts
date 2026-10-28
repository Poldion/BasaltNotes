import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { translateMessage } from '../src/i18n.js'
import { FakeLlm, makeApp } from './helpers.js'

let ctx: Awaited<ReturnType<typeof makeApp>>
const get = async (url: string, headers: Record<string, string> = {}) => {
  const r = await ctx.app.inject({ method: 'GET', url, headers: { ...ctx.auth, ...headers } })
  return r.json() as any
}

beforeAll(async () => {
  ctx = await makeApp(new FakeLlm([]))
})
afterAll(async () => ctx?.cleanup())

describe('Sprache der API-Meldungen', () => {
  it('Standard Deutsch, Englisch per X-Basalt-Lang oder Accept-Language', async () => {
    expect((await get('/api/v1/vaults/dnd/notes/gibtsnicht')).error.message).toBe('Notiz nicht gefunden.')
    expect((await get('/api/v1/vaults/dnd/notes/gibtsnicht', { 'x-basalt-lang': 'en' })).error.message).toBe('Note not found.')
    expect((await get('/api/v1/vaults/dnd/notes/gibtsnicht', { 'accept-language': 'en-US,en;q=0.9' })).error.message).toBe('Note not found.')
    expect((await get('/api/v1/vaults/dnd/notes/gibtsnicht', { 'accept-language': 'de-DE' })).error.message).toBe('Notiz nicht gefunden.')
    // Code bleibt gleich – Apps sollten sich danach richten
    expect((await get('/api/v1/vaults/dnd/notes/gibtsnicht', { 'x-basalt-lang': 'en' })).error.code).toBe('not_found')
  })

  it('Meldungen mit eingesetzten Werten', () => {
    expect(translateMessage('Kein Zugriff auf den Vault „geheim“.', 'en')).toBe('No access to vault “geheim”.')
    expect(translateMessage('Server http://x:1 nicht erreichbar: fetch failed', 'en')).toBe('Server http://x:1 not reachable: fetch failed')
    expect(translateMessage('Es gibt noch 3 Notiz(en) vom Typ „Wein“.', 'en')).toBe('There are still 3 note(s) of type “Wein”.')
    expect(translateMessage('Etwas ganz anderes.', 'en')).toBe('Etwas ganz anderes.')
  })

  it('Vorlagen-Ordner in der Sprache der Anfrage, Typen und Vorlagen bleiben gleich', async () => {
    const post = async (body: any, headers: Record<string, string> = {}) =>
      (await ctx.app.inject({ method: 'POST', url: '/api/v1/vaults', payload: body, headers: { ...ctx.auth, ...headers } })).json() as any
    await post({ name: 'Englisch DnD', preset: 'dnd' }, { 'x-basalt-lang': 'en' })
    const en = (await get('/api/v1/vaults/englisch-dnd/types')).items
    expect(en.find((t: any) => t.name === 'character').folder).toBe('{campaign}/Characters')
    expect(en.find((t: any) => t.name === 'item').folder).toBe('{campaign}/Items')
    expect(en.find((t: any) => t.name === 'session').folder).toBe('{campaign}/Sessions')
    await post({ name: 'Alltag EN', preset: 'notes', lang: 'en' })
    const notes = (await get('/api/v1/vaults/alltag-en/types')).items
    expect(notes.find((t: any) => t.name === 'journal').folder).toBe('Journal/{year}')
    const n = (await ctx.app.inject({ method: 'POST', url: '/api/v1/vaults/alltag-en/notes', payload: { title: 'Milk', type: 'task' }, headers: ctx.auth })).json() as any
    expect(n.path).toBe('Tasks/Milk.md')
    await post({ name: 'Deutsch DnD', preset: 'dnd' })
    expect((await get('/api/v1/vaults/deutsch-dnd/types')).items.find((t: any) => t.name === 'character').folder).toBe('{campaign}/Charaktere')
  })
})
