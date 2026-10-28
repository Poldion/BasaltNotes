export type ErrorCode =
  | 'not_found'
  | 'validation_error'
  | 'version_conflict'
  | 'forbidden'
  | 'unauthorized'
  | 'rate_limited'
  | 'llm_unavailable'
  | 'conflict'
  | 'internal_error'

const STATUS: Record<ErrorCode, number> = {
  not_found: 404,
  validation_error: 400,
  version_conflict: 409,
  conflict: 409,
  forbidden: 403,
  unauthorized: 401,
  rate_limited: 429,
  llm_unavailable: 503,
  internal_error: 500,
}

export class ApiError extends Error {
  readonly status: number
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.status = STATUS[code]
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } }
  }
}

/** Vom Benutzer abgebrochen (Kurator stoppen) – wird nicht wiederholt. */
export class CancelledError extends Error {
  readonly cancelled = true
  readonly noRetry = true
  constructor(message = 'Abgebrochen.') {
    super(message)
  }
}

export function isCancelled(e: unknown): boolean {
  return !!e && typeof e === 'object' && ((e as any).cancelled === true || (e as any).name === 'AbortError')
}

export const notFound = (what = 'Eintrag') => new ApiError('not_found', `${what} nicht gefunden.`)
export const invalid = (message: string, details?: Record<string, unknown>) => new ApiError('validation_error', message, details)
