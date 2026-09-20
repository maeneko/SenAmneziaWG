import { AWG_TOGGLES, awgToggleOn } from '../../shared/awgVersion'
import type { Tunnel } from '../../shared/types'
import type { TunnelSecrets } from '../config/wgConfig'
import { base64ToHex } from '../config/keys'

/**
 * Builds the `set=1` UAPI body. Order matters: device keys (private key, obfuscation) first,
 * then the peer. Keys are hex, everything is lowercase.
 */
export function buildUapiSet(tunnel: Tunnel, secrets: TunnelSecrets, endpointIp: string): string {
  const { awg } = tunnel
  const lines: string[] = ['set=1', `private_key=${base64ToHex(secrets.privateKey)}`, 'replace_peers=true']

  const numeric: [string, number][] = [
    ['jc', awg.jc],
    ['jmin', awg.jmin],
    ['jmax', awg.jmax],
    ['s1', awg.s1],
    ['s2', awg.s2]
  ]
  for (const [key, value] of numeric) if (value > 0) lines.push(`${key}=${value}`)

  const headers = [awg.h1, awg.h2, awg.h3, awg.h4]
  headers.forEach((value, i) => {
    if (value !== String(i + 1)) lines.push(`h${i + 1}=${value}`)
  })
  for (const [key, value] of Object.entries(awg.extra)) {
    if (value === '') continue // configs saved before empty I2–I5 were dropped at import
    // Amnezia writes these as on/off, which amneziawg-go's ParseBool rejects. Off is the daemon's
    // default, so it is left out: that also keeps a 3.0 daemon usable for such a config.
    if (AWG_TOGGLES.includes(key)) {
      if (awgToggleOn(value)) lines.push(`${key}=1`)
      continue
    }
    // Written in base64 in .conf like every other WireGuard key; amneziawg-go parses it as hex.
    lines.push(`${key}=${key === 'header_protection_key' ? base64ToHex(value) : value}`)
  }

  lines.push(`public_key=${base64ToHex(tunnel.peerPublicKey)}`)
  if (secrets.presharedKey) lines.push(`preshared_key=${base64ToHex(secrets.presharedKey)}`)
  lines.push(`endpoint=${formatEndpoint(endpointIp, endpointPort(tunnel.endpoint))}`)
  if (tunnel.keepalive) lines.push(`persistent_keepalive_interval=${tunnel.keepalive}`)
  lines.push('replace_allowed_ips=true')
  for (const cidr of tunnel.allowedIps) lines.push(`allowed_ip=${cidr}`)

  return lines.join('\n') + '\n\n'
}

export function splitEndpoint(endpoint: string): { host: string; port: string } {
  const v6 = /^\[(.+)]:(\d+)$/.exec(endpoint)
  if (v6) return { host: v6[1], port: v6[2] }
  const idx = endpoint.lastIndexOf(':')
  if (idx === -1) throw new Error('Endpoint должен быть в формате host:port')
  return { host: endpoint.slice(0, idx), port: endpoint.slice(idx + 1) }
}

const endpointPort = (endpoint: string): string => splitEndpoint(endpoint).port
const formatEndpoint = (ip: string, port: string): string => (ip.includes(':') ? `[${ip}]:${port}` : `${ip}:${port}`)
