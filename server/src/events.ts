import { EventEmitter } from 'node:events'
import { nowIso } from './db.js'

export type EventType =
  | 'note.created'
  | 'note.updated'
  | 'note.renamed'
  | 'note.deleted'
  | 'inbox.queued'
  | 'inbox.processed'
  | 'inbox.failed'
  | 'inbox.cancelled'
  | 'proposal.created'
  | 'proposal.resolved'
  | 'run.reverted'
  | 'vault.created'
  | 'vault.deleted'
  | 'vault.reindexed'
  | 'vault.types_changed'
  | 'system.features'
  | 'system.plugins'

export const EVENT_TYPES: EventType[] = [
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

export interface BasaltEvent {
  event: EventType
  vault: string | null
  at: string
  data: Record<string, any>
}

export class EventBus {
  private emitter = new EventEmitter()
  constructor() {
    this.emitter.setMaxListeners(0)
  }

  emit(event: EventType, vault: string | null, data: Record<string, any>): BasaltEvent {
    const e: BasaltEvent = { event, vault, at: nowIso(), data }
    this.emitter.emit('event', e)
    return e
  }

  on(fn: (e: BasaltEvent) => void): () => void {
    this.emitter.on('event', fn)
    return () => this.emitter.off('event', fn)
  }
}
