import { VpnLinkError } from '../config/vpnLink'
import { type ParsedTunnel, parseWgConfig } from '../config/wgConfig'
import type { SenConfig, SenServerConfig } from './store'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string'

/** Values end up on lines of a .conf: a line break would let the server (or whoever forged it) add keys. */
const clean = (v: string): boolean => !/[\r\n]/.test(v)

/**
 * Shapes the answer of the subscription server into a SenConfig, or throws with a user-readable message.
 * The signature is already checked by the time this runs; this guards the parser, not the trust.
 */
export function parseSenConfig(raw: unknown): SenConfig {
  const bad = (what: string): never => {
    throw new VpnLinkError(`Сервер подписки прислал неверные данные: ${what}`)
  }
  if (!isRecord(raw)) return bad('нет config')
  if (!str(raw.rev) || !raw.rev) bad('rev')
  if (!Array.isArray(raw.servers)) bad('servers')
  const endpoints = Array.isArray(raw.endpoints) ? raw.endpoints.filter((e): e is string => str(e) && /^[^\s]+:\d{1,5}$/.test(e)) : []

  const servers: SenServerConfig[] = (raw.servers as unknown[]).map((s, i) => {
    if (!isRecord(s)) return bad(`servers[${i}]`)
    const need = (k: string): string => {
      const v = s[k]
      if (!str(v) || !v || !clean(v)) bad(`servers[${i}].${k}`)
      return v as string
    }
    const awg: Record<string, string> = {}
    if (s.awg !== undefined) {
      if (!isRecord(s.awg)) bad(`servers[${i}].awg`)
      for (const [k, v] of Object.entries(s.awg as Record<string, unknown>)) {
        if (!/^[A-Za-z0-9_]{1,40}$/.test(k) || !str(v) || !clean(v)) bad(`servers[${i}].awg.${k}`)
        if (v !== '') awg[k] = v as string
      }
    }
    const dns = Array.isArray(s.dns) ? s.dns.filter((d): d is string => str(d) && d !== '' && clean(d)) : []
    return {
      id: Number.isInteger(s.id) ? (s.id as number) : i,
      name: str(s.name) && clean(s.name) ? s.name : 'AmneziaWG',
      endpoint: need('endpoint'),
      server_pub: need('server_pub'),
      psk: str(s.psk) && clean(s.psk) ? s.psk : '',
      address: need('address'),
      dns,
      keepalive: str(s.keepalive) && clean(s.keepalive) ? s.keepalive : '',
      mtu: Number.isInteger(s.mtu) && (s.mtu as number) > 0 ? (s.mtu as number) : undefined,
      gen: str(s.gen) ? s.gen : '2',
      awg
    }
  })
  const ids = new Set(servers.map((s) => s.id))
  if (ids.size !== servers.length) bad('повторяющиеся id серверов')

  return { rev: raw.rev as string, rekey: raw.rekey === true, endpoints, servers }
}

/**
 * One server of the master key as a tunnel. The text goes through parseWgConfig, as a vpn:// key's does, so
 * the keys are validated and the obfuscation parameters (2.0 and 3.1 alike) end up in the same shape.
 * `privateKey` is the device's own; the server never sends one.
 */
export function configToParsed(server: SenServerConfig, privateKey: string, name: string): ParsedTunnel {
  const iface = [
    `PrivateKey = ${privateKey}`,
    `Address = ${server.address}`,
    ...(server.dns.length ? [`DNS = ${server.dns.join(', ')}`] : []),
    ...Object.entries(server.awg).map(([k, v]) => `${k} = ${v}`)
  ]
  const peer = [
    `PublicKey = ${server.server_pub}`,
    ...(server.psk ? [`PresharedKey = ${server.psk}`] : []),
    'AllowedIPs = 0.0.0.0/0, ::/0',
    `Endpoint = ${server.endpoint}`,
    ...(server.keepalive ? [`PersistentKeepalive = ${server.keepalive}`] : [])
  ]
  return parseWgConfig(`[Interface]\n${iface.join('\n')}\n\n[Peer]\n${peer.join('\n')}\n`, { name, mtu: server.mtu })
}
