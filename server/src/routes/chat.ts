import type { FastifyRequest } from 'fastify'
import type { ChatRequest } from '../chat/chat.js'
import { ApiError, invalid, isCancelled } from '../lib/errors.js'
import { requestLang, translateMessage } from '../i18n.js'
import { T, accessOf, vaultFor, visibilityOf, type Register } from './common.js'

const bodySchema = {
  type: 'object',
  required: ['question'],
  properties: {
    question: { type: 'string', minLength: 1, maxLength: 2000 },
    history: { type: 'array', maxItems: 20, items: { type: 'object', properties: { role: { type: 'string', enum: ['user', 'assistant'] }, content: { type: 'string' } } } },
    previous: { type: 'array', maxItems: 10, items: { type: 'string' } },
    focus: { type: 'array', maxItems: 5, items: { type: 'string' } },
    campaign: { type: ['string', 'null'] },
    stream: { type: 'boolean' },
    include_context: { type: 'boolean' },
  },
}

function chatRequest(req: FastifyRequest): ChatRequest {
  const b = req.body as any
  if (!b?.question?.trim()) throw invalid('Frage fehlt.')
  return {
    question: String(b.question),
    history: b.history,
    previous: b.previous,
    focus: b.focus,
    // Spieler-Links sind auf ihre Kampagne beschränkt
    campaign: b.campaign ?? null,
    visibility: visibilityOf(req),
    restriction: accessOf(req, String((req.params as any).vault)),
  }
}

export const registerChat: Register = (app, s) => {
  app.post(
    '/vaults/:vault/chat/context',
    { schema: { tags: T.search, summary: 'Chat: nur den Kontext bestimmen, der an das LLM gehen würde (ohne LLM)', body: bodySchema } },
    async (req) => {
      const v = vaultFor(req, s, 'read')
      return s.chat.buildContext(v.id, chatRequest(req))
    },
  )

  app.post(
    '/vaults/:vault/chat',
    {
      schema: {
        tags: T.search,
        summary: 'Mit den Notizen chatten. Passende Einträge werden ohne LLM vorausgewählt; mit "stream": true als Server-Sent Events (context, start, thinking, token, done, error)',
        body: bodySchema,
      },
    },
    async (req, reply) => {
      const v = vaultFor(req, s, 'read')
      const cr = chatRequest(req)
      const b = req.body as any
      const ctrl = new AbortController()
      req.raw.on('close', () => {
        if (!reply.raw.writableEnded) ctrl.abort()
      })
      const sourcesOf = (c: any) => ({ sources: c.sources, focus: c.focus, chars: c.chars, budget: c.budget, list_types: c.list_types })

      if (!b.stream) {
        const r = await s.chat.ask(v.id, cr, {}, ctrl.signal)
        return { answer: r.answer, llm: r.llm, ...sourcesOf(r.context), ...(b.include_context ? { context: r.context.text } : {}) }
      }

      reply.hijack()
      const res = reply.raw
      const headers: Record<string, string> = {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      }
      const origin = req.headers.origin
      if (origin && s.config.corsOrigins.includes(origin)) {
        headers['access-control-allow-origin'] = origin
        headers['access-control-allow-credentials'] = 'true'
      }
      res.writeHead(200, headers)
      const send = (event: string, data: unknown) => {
        if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }
      // Hält die Verbindung offen, solange das LLM noch hinter dem Kurator wartet
      const ping = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), 15_000)
      try {
        const r = await s.chat.ask(
          v.id,
          cr,
          {
            onContext: (c) => send('context', { ...sourcesOf(c), ...(b.include_context ? { context: c.text } : {}) }),
            onStart: () => send('start', {}),
            onText: (t) => send('token', { text: t }),
            onThinking: (t) => send('thinking', { text: t }),
          },
          ctrl.signal,
        )
        send('done', { answer: r.answer, llm: r.llm })
      } catch (e) {
        if (!isCancelled(e)) {
          const err = e instanceof ApiError ? e.toJSON().error : { code: 'internal_error', message: (e as Error).message }
          send('error', { ...err, message: translateMessage(err.message, requestLang(req)) })
        }
      } finally {
        clearInterval(ping)
        res.end()
      }
    },
  )
}
