import { describe, expect, it, vi, afterEach } from 'vitest'
import { buildDnsQuery } from '../src/main/tunnel/healthCheck'
import { resolveEndpoint } from '../src/main/doh'

/** The wire response for the query in `init.body`, with one A answer (and a TTL). */
function answer(body: Uint8Array | undefined, ip: [number, number, number, number], ttl: number): Response {
  const id = body ? Buffer.from(body).readUInt16BE(0) : 0
  const query = buildDnsQuery(id, 'example.com')
  const head = Buffer.from([id >> 8, id & 0xff, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0])
  // answer: a pointer to the question's name (0xC00C), then type, class, ttl, rdlength, rdata
  const rr = Buffer.alloc(16)
  rr.writeUInt16BE(0xc00c, 0)
  rr.writeUInt16BE(1, 2)
  rr.writeUInt16BE(1, 4)
  rr.writeUInt32BE(ttl, 6)
  rr.writeUInt16BE(4, 10)
  rr.set(ip, 12)
  return new Response(Buffer.concat([head, query.subarray(12), rr]), { headers: { 'content-type': 'application/dns-message' } })
}

const IP: [number, number, number, number] = [93, 184, 216, 34]

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('resolveEndpoint (DoH)', () => {
  it('asks the pinned resolver over HTTPS and reads the A record', async () => {
    const fetch = vi.fn(async (url: string | URL, init?: { body?: Uint8Array }) => answer(init?.body, IP, 300))
    vi.stubGlobal('fetch', fetch)
    await expect(resolveEndpoint('first.example', 'cloudflare')).resolves.toBe('93.184.216.34')
    // The resolver pinned by its address: finding it must not need DNS.
    expect(fetch.mock.calls[0][0]).toBe('https://1.1.1.1/dns-query')
  })

  it('remembers the answer for its TTL: the same host needs no second request', async () => {
    const fetch = vi.fn(async (_url: string | URL, init?: { body?: Uint8Array }) => answer(init?.body, IP, 120))
    vi.stubGlobal('fetch', fetch)
    await expect(resolveEndpoint('second.example', 'custom', 'https://dns.example/dns-query')).resolves.toBe('93.184.216.34')
    await expect(resolveEndpoint('second.example', 'custom', 'https://dns.example/dns-query')).resolves.toBe('93.184.216.34')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toBe('https://dns.example/dns-query')
  })

  it('a «своя ссылка» that is not an https URL is not used: the system resolver answers', async () => {
    // The endpoint is an IP here, so the system resolver itself is never reached in the test.
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(resolveEndpoint('192.0.2.5', 'custom', 'http://dns.example/dns-query')).resolves.toBe('192.0.2.5')
    await expect(resolveEndpoint('192.0.2.5', 'custom', 'не ссылка')).resolves.toBe('192.0.2.5')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('an answer without A records refuses', async () => {
    // A NOERROR with zero answers: the name is not there.
    const empty = async (init?: { body?: Uint8Array }): Promise<Response> => {
      const id = init?.body ? Buffer.from(init.body).readUInt16BE(0) : 0
      const query = buildDnsQuery(id, 'example.com')
      const head = Buffer.from([id >> 8, id & 0xff, 0x81, 0x80, 0, 1, 0, 0, 0, 0, 0, 0])
      return new Response(Buffer.concat([head, query.subarray(12)]))
    }
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: { body?: Uint8Array }) => empty(init)))
    await expect(resolveEndpoint('third.example', 'cloudflare')).rejects.toThrow(/DoH:/)
  })

  it('a name that is already an address needs nobody', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(resolveEndpoint('192.0.2.1', 'cloudflare')).resolves.toBe('192.0.2.1')
    expect(fetch).not.toHaveBeenCalled()
  })
})
