import { createSocket } from 'node:dgram'
import { isIPv4 } from 'node:net'

/**
 * Round-trip time measured with a DNS query, because WireGuard has no latency of its own to report:
 * the protocol carries no timestamps and the UAPI gives only counters and the last handshake time.
 *
 * A DNS server always answers, which ICMP hosts often do not — many providers drop echo requests,
 * and a silent server that works perfectly would look dead. While the tunnel is up the query is
 * routed through it, so what comes back is the latency of the tunnel itself.
 */

/** Resolvers to fall back on when the configuration names none. They answer from anywhere. */
const PUBLIC_DNS = ['1.1.1.1', '8.8.8.8']

const PROBES = 3
const TIMEOUT_MS = 2000

/** A random label keeps every probe distinct, so a resolver cannot answer two of them from its cache. */
const randomName = (): string => Math.random().toString(36).slice(2, 10)

const label = (text: string): number[] => [text.length, ...Buffer.from(text, 'ascii')]

/** A standard recursive A/IN query for <name>.example.com — the smallest thing a resolver will answer. */
export function buildQuery(id: number, name: string): Buffer {
  return Buffer.from([
    id >> 8,
    id & 0xff,
    0x01, // recursion desired
    0x00,
    0x00,
    0x01, // one question
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    ...label(name),
    ...label('example'),
    ...label('com'),
    0x00,
    0x00,
    0x01, // A
    0x00,
    0x01 // IN
  ])
}

/** Ours only if it is a response and carries the id we sent. Anything else on the socket is noise. */
export function isReplyTo(message: Buffer, id: number): boolean {
  return message.length >= 12 && message.readUInt16BE(0) === id && (message[2] & 0x80) !== 0
}

/** One query, one answer, one number. Resolves to milliseconds, or null if nothing came back in time. */
export function probe(host: string, timeoutMs = TIMEOUT_MS): Promise<number | null> {
  return new Promise((resolve) => {
    const id = Math.floor(Math.random() * 0x10000)
    const socket = createSocket('udp4')
    let settled = false
    const finish = (ms: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.close()
      resolve(ms)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)

    socket.on('message', (message) => {
      if (isReplyTo(message, id)) finish(Number(process.hrtime.bigint() - started) / 1e6)
    })
    socket.on('error', () => finish(null))
    // hrtime is monotonic: a clock adjustment mid-probe cannot turn the result negative.
    const started = process.hrtime.bigint()
    socket.send(buildQuery(id, randomName()), 53, host)
  })
}

/** The best of what came back, rounded. Jitter only ever adds delay, so the smallest sample is the honest one. */
export function best(samples: (number | null)[]): number | null {
  const got = samples.filter((ms): ms is number => ms !== null)
  return got.length === 0 ? null : Math.round(Math.min(...got))
}

/** Which server to ask: the one the tunnel pushed, or a public resolver when it pushed none. */
export function pingTargets(dns: string[]): string[] {
  const own = dns.filter((address) => isIPv4(address))
  return own.length > 0 ? own : PUBLIC_DNS
}

/**
 * Latency in milliseconds, or null when nothing answered. Several probes go out at once and the
 * best is kept: one packet is one sample, and on Wi-Fi two samples in a row differ by tens of ms.
 */
export async function measurePing(dns: string[]): Promise<number | null> {
  const [target] = pingTargets(dns)
  return best(await Promise.all(Array.from({ length: PROBES }, () => probe(target))))
}
