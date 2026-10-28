import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildApp } from '../src/app.js'
import type { ChatJsonOptions, ChatTextOptions, LlmClient, LlmInfo } from '../src/curator/llm.js'
import { nameSimilarity } from '../src/lib/similarity.js'
import { CancelledError } from '../src/lib/errors.js'

/** Deterministisches LLM für Tests: liefert vorbereitete Extraktionen, Abgleich über Ähnlichkeit. */
export class FakeLlm implements LlmClient {
  calls: ChatJsonOptions[] = []
  textCalls: ChatTextOptions[] = []
  /** Antwort für den Chat */
  textAnswer = 'Kefir ist ein Koboldmagier [Kefir].'
  /** Künstliche Antwortzeit (für Abbruch-Tests) */
  delayMs = 0
  constructor(private extractions: { match: RegExp; result: any }[]) {}

  async info(): Promise<LlmInfo> {
    return { url: 'fake', reachable: true, model: 'fake-model', context: 8192, context_source: 'config', checked: new Date().toISOString() }
  }

  async inputBudget(systemChars: number) {
    return Math.max(1500, (8192 - Math.ceil(systemChars / 3) - 2048) * 3)
  }

  async chatText(opts: ChatTextOptions): Promise<string> {
    this.textCalls.push(opts)
    opts.onStart?.()
    for (const piece of this.textAnswer.match(/.{1,8}/g) ?? []) opts.onText?.(piece)
    return this.textAnswer
  }

  async chatJson<T>(opts: ChatJsonOptions): Promise<T> {
    this.calls.push(opts)
    if (this.delayMs) {
      await new Promise<void>((resolve, reject) => {
        if (opts.signal?.aborted) return reject(new CancelledError())
        const t = setTimeout(resolve, this.delayMs)
        opts.signal?.addEventListener('abort', () => {
          clearTimeout(t)
          reject(new CancelledError())
        })
      })
    }
    if (opts.system.startsWith('Entscheide')) {
      const mention = /Neue Erwähnung: "([^"]+)"/.exec(opts.user)?.[1] ?? ''
      const names = mention.split(' / ')
      const cands = [...opts.user.matchAll(/^\d+\. (\S+) (.+?) \(/gm)].map((m) => ({ id: m[1], title: m[2] }))
      let best = { id: 'new', score: 0 }
      for (const c of cands) for (const n of names) {
        const sc = nameSimilarity(n, c.title)
        if (sc > best.score) best = { id: c.id, score: sc }
      }
      return { match: best.score >= 0.6 ? best.id : 'new', confidence: 0.9, reason: 'Schreibvariante' } as T
    }
    const hit = this.extractions.find((e) => e.match.test(opts.user))
    return (hit?.result ?? { entities: [], events: [], quests: [], facts: [] }) as T
  }
}

export async function makeApp(llm: LlmClient, opts: { config?: Partial<import('../src/config.js').AppConfig> } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'basalt-test-'))
  process.env.ADMIN_PASSWORD = 'testpasswort123'
  const { app, services } = await buildApp({
    config: { dataDir, watch: false, commitDelayMs: 20, corsOrigins: [], embedOrigins: [], features: { curator: true, chat: true, setup_done: true }, ...(opts.config ?? {}) },
    llm,
    logger: false,
    webDir: null,
  })
  const admin = services.auth.createToken({ name: 'test', vaults: '*', scopes: ['admin'] })
  const auth = { authorization: `Bearer ${admin.token}` }
  const cleanup = async () => {
    await app.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
  return { app, services, auth, dataDir, cleanup }
}
