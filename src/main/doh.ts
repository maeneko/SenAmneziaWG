import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { isDohUrl, type DohMode } from '../shared/uiSettings'
import { buildDnsQuery, isDnsAnswer } from './tunnel/healthCheck'

/**
 * DoH («Сеть» → DoH): the tunnel's endpoint hostname is resolved over HTTPS, so the provider's DNS
 * never sees the name of the server about to be connected to. The built-in resolver is pinned to
 * its well-known address — finding the resolver itself must not need DNS — and serves a valid
 * certificate straight on that IP. The user's own endpoint is taken as typed.
 */
const CLOUDFLARE = 'https://1.1.1.1/dns-query'

/** A hostname is remembered for at least this long, seconds; the answers' own TTL may be longer. */
const CACHE_TTL_MIN = 60

const cache = new Map<string, { address: string; until: number }>()

/** Skips one (possibly compressed) domain name; returns the offset right after it. */
function skipName(msg: Buffer, off: number): number {
  for (;;) {
    const len = msg[off]
    if (len === 0) return off + 1
    if ((len & 0xc0) === 0xc0) return off + 2
    off += len + 1
  }
}

/** The response's A records and the smallest of their TTLs; throws when the answer holds none. */
function parseARecords(msg: Buffer, id: number): { addresses: string[]; ttl: number } {
  if (!isDnsAnswer(msg, id)) throw new Error('DoH: ответ не распознан')
  let off = skipName(msg, 12) + 4 // question name, then qtype + qclass
  const answers = msg.readUInt16BE(6)
  const addresses: string[] = []
  let ttl = CACHE_TTL_MIN
  for (let i = 0; i < answers && off + 10 <= msg.length; i++) {
    off = skipName(msg, off)
    const type = msg.readUInt16BE(off)
    off += 2
    off += 2 // class
    const rrTtl = msg.readUInt32BE(off)
    off += 4
    const rdlen = msg.readUInt16BE(off)
    off += 2
    if (type === 1 && rdlen === 4) {
      addresses.push(`${msg[off]}.${msg[off + 1]}.${msg[off + 2]}.${msg[off + 3]}`)
      ttl = Math.min(ttl, rrTtl)
    }
    off += rdlen
  }
  if (!addresses.length) throw new Error('DoH: в ответе нет A-записи')
  return { addresses, ttl }
}

async function dohLookup(url: string, host: string): Promise<string> {
  const hit = cache.get(host)
  if (hit && hit.until > Date.now()) return hit.address
  const id = Math.floor(Math.random() * 0xffff)
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/dns-message' },
    body: new Uint8Array(buildDnsQuery(id, host)),
    signal: AbortSignal.timeout(5000)
  })
  const { addresses, ttl } = parseARecords(Buffer.from(await res.arrayBuffer()), id)
  cache.set(host, { address: addresses[0], until: Date.now() + ttl * 1000 })
  return addresses[0]
}

/** The system resolver, as the endpoints were always resolved. */
export const systemEndpoint = async (host: string): Promise<string> => (await lookup(host)).address

/** A server address by its name: DoH when «Сеть» says so, the system resolver otherwise. A «своя
 *  ссылка» that is not a well-formed https URL yet resolves the usual way, not over DoH. */
export async function resolveEndpoint(host: string, doh: DohMode, dohUrl = ''): Promise<string> {
  if (isIP(host)) return host
  if (doh === 'cloudflare') return dohLookup(CLOUDFLARE, host)
  if (doh === 'custom' && isDohUrl(dohUrl)) return dohLookup(dohUrl, host)
  return systemEndpoint(host)
}
