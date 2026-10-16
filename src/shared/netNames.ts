/**
 * Names and addresses as the routing code accepts them. Everything here ends up in the root helper (DNS
 * matcher, routing commands), so the checks are strict and shared by main and the renderer.
 */

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

/**
 * A plain IPv4 or IPv6 address: no port, prefix or zone. IPv6 is checked by the WHATWG URL parser,
 * which exists in both main and the renderer and is exact about the format.
 */
export function isIpAddress(value: string): boolean {
  if (IPV4.test(value)) return true
  if (!value.includes(':') || !/^[0-9A-Fa-f:.]+$/.test(value)) return false
  try {
    new URL(`http://[${value}]/`)
    return true
  } catch {
    return false
  }
}

const DOMAIN_CHARS = /^[\p{L}\p{N}.-]+$/u
const DOMAIN_ASCII = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/

/**
 * A site as the DNS proxy matches it: lower case, punycode, no «*.» and no trailing dot; null when it
 * is not a domain name (an address, a path, a single label such as «com»). Subdomains are covered by the
 * helper, so «example.com» and «*.example.com» mean the same.
 */
export function normalizeDomain(value: string): string | null {
  let d = value.trim().toLowerCase()
  if (d.startsWith('*.')) d = d.slice(2)
  if (d.endsWith('.')) d = d.slice(0, -1)
  if (!d || !DOMAIN_CHARS.test(d)) return null
  let host: string
  try {
    host = new URL(`http://${d}/`).hostname
  } catch {
    return null
  }
  if (host.length > 253 || !DOMAIN_ASCII.test(host)) return null
  // «1.2.3.4» is an address, not a site: the proxy never sees those.
  if (/^[0-9]+$/.test(host.slice(host.lastIndexOf('.') + 1))) return null
  return host
}

/** The shortest prefixes a rule may name: «/0» would override the whole routing table, so would «/1». */
export const MIN_CIDR_V4 = 8
export const MIN_CIDR_V6 = 16

/**
 * An address or a network in CIDR form: the text as it should be sent (IPv6 in lower case), or a reason in
 * Russian. A bare address means one host.
 */
export function parseIpOrCidr(value: string): { ok: true; value: string } | { ok: false; error: string } {
  const text = value.trim()
  const slash = text.indexOf('/')
  const addr = slash < 0 ? text : text.slice(0, slash)
  if (!isIpAddress(addr)) return { ok: false, error: 'Не похоже на IP-адрес или сеть вида 10.0.0.0/8' }
  const v6 = addr.includes(':')
  if (slash < 0) return { ok: true, value: v6 ? addr.toLowerCase() : addr }
  const bitsText = text.slice(slash + 1)
  if (!/^\d{1,3}$/.test(bitsText)) return { ok: false, error: 'Длина сети — число после «/»' }
  const bits = Number(bitsText)
  const max = v6 ? 128 : 32
  if (bits > max) return { ok: false, error: `Длина сети не больше ${max}` }
  const min = v6 ? MIN_CIDR_V6 : MIN_CIDR_V4
  if (bits < min) return { ok: false, error: `Сеть слишком широкая: длина не меньше ${min}` }
  return { ok: true, value: `${v6 ? addr.toLowerCase() : addr}/${bits}` }
}
