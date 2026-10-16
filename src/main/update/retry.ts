/**
 * The update server drops connections and stalls now and then (a few requests in a hundred time out, more are
 * slow), and an update in pieces is twenty requests: with no second try, one hiccup was enough to give up the
 * small download and fetch the whole installer instead. Everything that talks to the server goes through here:
 * a request that does not get an answer is made again, a stream that goes quiet is cut and made again, and only
 * a server that keeps failing ends the attempt.
 */

/** The server answered, but not with what was asked for. */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

/** A stream that stopped giving data. */
export class StallError extends Error {}

/** Worth asking again: the network failed, the server is busy or broken. A 404 will be a 404 the next time too. */
export function isTransient(err: unknown): boolean {
  if (err instanceof HttpStatusError) return err.status >= 500 || err.status === 408 || err.status === 429
  return true
}

export interface RetryOptions {
  /** How many times in all the operation is tried. */
  attempts?: number
  /** The pause before the second, third… try. The last one repeats when there are more tries than pauses. */
  delaysMs?: readonly number[]
  /** Tests bring their own, so they do not wait. */
  sleep?: (ms: number) => Promise<void>
  /** Said before each new try, with the reason the last one failed. */
  onRetry?: (err: unknown, nextAttempt: number, attempts: number) => void
  /** Whether a failure is worth another try; `isTransient` unless given. */
  retryable?: (err: unknown) => boolean
}

export const RETRY_ATTEMPTS = 5
export const RETRY_DELAYS_MS: readonly number[] = [400, 1200, 3000, 6000]

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Runs `op` until it succeeds, a failure is not worth repeating, or the tries are spent (then the last failure is thrown). */
export async function retry<T>(op: (attempt: number) => Promise<T>, o: RetryOptions = {}): Promise<T> {
  const attempts = o.attempts ?? RETRY_ATTEMPTS
  const delays = o.delaysMs ?? RETRY_DELAYS_MS
  const sleep = o.sleep ?? realSleep
  const retryable = o.retryable ?? isTransient
  for (let attempt = 1; ; attempt++) {
    try {
      return await op(attempt)
    } catch (err) {
      if (attempt >= attempts || !retryable(err)) throw err
      o.onRetry?.(err, attempt + 1, attempts)
      await sleep(delays.length ? delays[Math.min(attempt - 1, delays.length - 1)] : 0)
    }
  }
}

/** `fetch` that gives up waiting for the answer's headers after `ms` (the body is another matter: idleGuard). */
export function timedFetch(base: typeof fetch, ms: number): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const own = new AbortController()
    const timer = setTimeout(() => own.abort(new StallError(`сервер не ответил за ${Math.round(ms / 1000)} с`)), ms)
    const signal = init?.signal ? AbortSignal.any([init.signal, own.signal]) : own.signal
    try {
      return await base(input, { ...init, signal })
    } finally {
      clearTimeout(timer)
    }
  }) as typeof fetch
}

/**
 * The same body, but a pause of `ms` between two pieces ends it with a StallError (and lets go of the connection)
 * instead of waiting for ever.
 */
export function idleGuard(body: ReadableStream<Uint8Array>, ms: number): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const next = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new StallError(`сервер перестал отдавать данные на ${Math.round(ms / 1000)} с`)), ms)
          })
        ])
        if (next.done) controller.close()
        else controller.enqueue(next.value)
      } catch (err) {
        void reader.cancel().catch(() => undefined)
        controller.error(err)
      } finally {
        clearTimeout(timer)
      }
    },
    cancel: (reason) => reader.cancel(reason)
  })
}

export interface Resilience extends RetryOptions {
  /** How long the server may take to start answering. */
  headersMs?: number
  /** How long a stream may go quiet. */
  idleMs?: number
}

export const HEADERS_MS = 15_000
export const IDLE_MS = 15_000

/**
 * A small answer (a list, a signature, the site's JSON): the whole request, body included, is repeated when it
 * fails or comes back short. A status that will not change (404) is thrown as it is, for the caller to read.
 */
export async function fetchBuffer(base: typeof fetch, url: string | URL, init: RequestInit | undefined, o: Resilience = {}): Promise<Buffer> {
  const timed = timedFetch(base, o.headersMs ?? HEADERS_MS)
  return retry(async () => {
    const res = await timed(url, init)
    if (!res.ok) throw new HttpStatusError(res.status, `${String(url)}: ${res.status}`)
    if (!res.body) return Buffer.alloc(0)
    const chunks: Buffer[] = []
    const reader = idleGuard(res.body, o.idleMs ?? IDLE_MS).getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
  }, o)
}

/** A request whose answer is only its status and headers (HEAD, or a GET about to be streamed). */
export function fetchHead(base: typeof fetch, url: string | URL, init: RequestInit | undefined, o: Resilience = {}): Promise<Response> {
  const timed = timedFetch(base, o.headersMs ?? HEADERS_MS)
  return retry(async () => {
    const res = await timed(url, init)
    if (!res.ok) throw new HttpStatusError(res.status, `${String(url)}: ${res.status}`)
    return res
  }, o)
}
