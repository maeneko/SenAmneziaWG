import { describe, expect, it, vi } from 'vitest'
import { fetchBuffer, fetchHead, HttpStatusError, idleGuard, isTransient, retry, StallError, timedFetch } from '../src/main/update/retry'

const noSleep = (log: number[] = []) => async (ms: number): Promise<void> => void log.push(ms)

describe('isTransient', () => {
  it('a network failure, a timeout and a busy or broken server are worth another try; a 404 is not', () => {
    expect(isTransient(new TypeError('fetch failed'))).toBe(true)
    expect(isTransient(new StallError('x'))).toBe(true)
    for (const status of [500, 502, 503, 504, 408, 429]) expect(isTransient(new HttpStatusError(status, 'x')), String(status)).toBe(true)
    for (const status of [400, 401, 403, 404, 410]) expect(isTransient(new HttpStatusError(status, 'x')), String(status)).toBe(false)
  })
})

describe('retry', () => {
  it('returns at once when the first try works', async () => {
    const op = vi.fn(async () => 'ok')
    expect(await retry(op, { sleep: noSleep() })).toBe('ok')
    expect(op).toHaveBeenCalledTimes(1)
  })

  it('tries again after a failure, with the pauses it was given, and says why', async () => {
    const pauses: number[] = []
    const said: string[] = []
    let n = 0
    const op = async (): Promise<string> => {
      if (++n < 3) throw new Error(`broke ${n}`)
      return 'ok'
    }
    expect(await retry(op, { sleep: noSleep(pauses), delaysMs: [10, 20, 30], onRetry: (e, next, all) => said.push(`${(e as Error).message} → ${next}/${all}`) })).toBe('ok')
    expect(pauses).toEqual([10, 20])
    expect(said).toEqual(['broke 1 → 2/5', 'broke 2 → 3/5'])
  })

  it('gives up after the tries are spent and throws the last failure; the last pause repeats', async () => {
    const pauses: number[] = []
    let n = 0
    await expect(retry(async () => { throw new Error(`broke ${++n}`) }, { attempts: 4, delaysMs: [5, 7], sleep: noSleep(pauses) })).rejects.toThrow('broke 4')
    expect(pauses).toEqual([5, 7, 7])
  })

  it('does not repeat what will not change', async () => {
    const op = vi.fn(async () => { throw new HttpStatusError(404, 'gone') })
    await expect(retry(op, { sleep: noSleep() })).rejects.toThrow('gone')
    expect(op).toHaveBeenCalledTimes(1)
    const custom = vi.fn(async () => { throw new Error('x') })
    await expect(retry(custom, { sleep: noSleep(), retryable: () => false })).rejects.toThrow('x')
    expect(custom).toHaveBeenCalledTimes(1)
  })
})

describe('timedFetch', () => {
  it('lets an answer through, and aborts one that never starts', async () => {
    const fast = timedFetch((async () => new Response('hi')) as typeof fetch, 1000)
    expect(await (await fast('https://x.test/')).text()).toBe('hi')
    const hang = timedFetch(((_u: unknown, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))) as typeof fetch, 30)
    await expect(hang('https://x.test/')).rejects.toBeInstanceOf(StallError)
  })

  it('also stops when the caller aborts', async () => {
    const ac = new AbortController()
    const hang = timedFetch(((_u: unknown, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as typeof fetch, 5000)
    const p = hang('https://x.test/', { signal: ac.signal })
    ac.abort()
    await expect(p).rejects.toThrow('aborted')
  })
})

describe('idleGuard', () => {
  const stream = (steps: (Uint8Array | 'stall')[]): ReadableStream<Uint8Array> => {
    let i = 0
    return new ReadableStream<Uint8Array>({
      async pull(c) {
        const s = steps[i++]
        if (s === undefined) return c.close()
        if (s === 'stall') return new Promise(() => undefined)
        c.enqueue(s)
      }
    })
  }
  const drain = async (s: ReadableStream<Uint8Array>): Promise<number> => {
    const r = s.getReader()
    let n = 0
    for (;;) {
      const { done, value } = await r.read()
      if (done) return n
      n += value.length
    }
  }

  it('passes a stream that keeps going', async () => {
    expect(await drain(idleGuard(stream([new Uint8Array(3), new Uint8Array(4)]), 1000))).toBe(7)
  })

  it('cuts one that goes quiet, with a StallError', async () => {
    await expect(drain(idleGuard(stream([new Uint8Array(3), 'stall']), 30))).rejects.toBeInstanceOf(StallError)
  })
})

describe('fetchBuffer and fetchHead', () => {
  const quick = { sleep: noSleep(), headersMs: 100, idleMs: 100 }

  it('repeats a request that failed, and gives the body whole', async () => {
    let n = 0
    const base = (async () => {
      if (++n === 1) throw new TypeError('fetch failed')
      if (n === 2) return new Response('', { status: 503 })
      return new Response('the list')
    }) as typeof fetch
    expect((await fetchBuffer(base, 'https://x.test/a', undefined, quick)).toString()).toBe('the list')
    expect(n).toBe(3)
  })

  it('repeats one whose body stopped halfway', async () => {
    let n = 0
    const base = (async () => {
      n++
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('par'))
          if (n > 1) {
            c.enqueue(new TextEncoder().encode('t two'))
            c.close()
          }
        }
      })
      return new Response(body)
    }) as typeof fetch
    expect((await fetchBuffer(base, 'https://x.test/a', undefined, quick)).toString()).toBe('part two')
    expect(n).toBe(2)
  })

  it('a 404 is thrown at once, as an HttpStatusError the caller can read', async () => {
    let n = 0
    const base = (async () => (++n, new Response('', { status: 404 }))) as typeof fetch
    await expect(fetchBuffer(base, 'https://x.test/a', undefined, quick)).rejects.toMatchObject({ status: 404 })
    await expect(fetchHead(base, 'https://x.test/a', { method: 'HEAD' }, quick)).rejects.toMatchObject({ status: 404 })
    expect(n).toBe(2)
  })

  it('fetchHead repeats a server that is down for a moment', async () => {
    let n = 0
    const base = (async () => (++n < 3 ? new Response('', { status: 502 }) : new Response(null, { headers: { 'content-length': '7' } }))) as typeof fetch
    const res = await fetchHead(base, 'https://x.test/a', { method: 'HEAD' }, quick)
    expect(res.headers.get('content-length')).toBe('7')
    expect(n).toBe(3)
  })
})
