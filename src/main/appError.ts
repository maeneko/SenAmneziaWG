import { codedMessage, splitErrorCode, type ErrorCode } from '../shared/errorCatalog'

/**
 * An error from the catalog (src/shared/errorCatalog.ts, docs/errors.md). Its message is «КОД: текст»: what the
 * window shows, carried through IPC as it is. `detail` is what only the journal gets — an HTTP status, the system's
 * or the service's own words.
 */
export class AppError extends Error {
  constructor(
    readonly errorCode: ErrorCode,
    params?: Record<string, string>,
    readonly detail?: string
  ) {
    super(codedMessage(errorCode, params))
  }
}

const words = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * A failure as the window should see it: a catalog error stays as it is; anything else becomes `fallback` — ERR-00
 * unless the caller knows better — with its own words kept as the detail for the journal.
 */
export function asAppError(err: unknown, fallback: ErrorCode = 'ERR-00'): AppError {
  if (err instanceof AppError) return err
  const { code } = splitErrorCode(words(err))
  if (code) return Object.assign(new AppError(code), { message: words(err) })
  return new AppError(fallback, undefined, words(err))
}

/** The journal line for a failure: «[КОД] текст · подробности». */
export function failureLine(err: unknown): string {
  const e = asAppError(err)
  const { code, text } = splitErrorCode(e.message)
  return `[${code ?? e.errorCode}] ${text}${e.detail ? ` · ${e.detail}` : ''}`
}
