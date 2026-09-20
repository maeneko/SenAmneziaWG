import { AWG_CONF_KEYS, AWG_TOGGLES, awgToggleOn } from '../../shared/awgVersion'
import type { Tunnel } from '../../shared/types'
import type { TunnelSecrets } from './wgConfig'

/** Small on purpose: obfuscation padding eats into the path MTU, and a too-large value black-holes traffic silently. */
export const DEFAULT_MTU = 1280

/**
 * A `.conf` is line-based and its reader cuts everything after `#`, so one stray character would
 * change what a value means (a new key on the next line, a truncated endpoint). Refuse instead.
 */
function line(key: string, value: string): string {
  if (/[\r\n#]/.test(value)) throw new Error(`Значение ${key} содержит недопустимые символы`)
  return `${key} = ${value}`
}

const csv = (v: string): string[] =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

/**
 * Tunnel → AmneziaWG `.conf`, the inverse of parseWgConfig. Follows buildUapiSet's conventions for what
 * "unset" means, so every backend agrees: zero numbers, default headers, empty values and switched-off
 * 3.1 toggles are left out. No PreUp/PostUp/PreDown/PostDown: nothing here may run commands.
 */
export function buildWgConf(tunnel: Tunnel, secrets: TunnelSecrets, dns: string[] = tunnel.dns): string {
  const { awg } = tunnel
  const iface = [line('PrivateKey', secrets.privateKey), line('Address', csv(tunnel.address).join(', '))]
  if (dns.length) iface.push(line('DNS', dns.join(', ')))
  iface.push(line('MTU', String(tunnel.mtu ?? DEFAULT_MTU)))

  const numeric: [string, number][] = [
    ['Jc', awg.jc],
    ['Jmin', awg.jmin],
    ['Jmax', awg.jmax],
    ['S1', awg.s1],
    ['S2', awg.s2]
  ]
  for (const [key, value] of numeric) if (value > 0) iface.push(line(key, String(value)))

  const headers = [awg.h1, awg.h2, awg.h3, awg.h4]
  headers.forEach((value, i) => {
    if (value !== String(i + 1)) iface.push(line(`H${i + 1}`, value))
  })

  for (const [key, value] of Object.entries(awg.extra)) {
    if (value === '') continue
    const name = AWG_CONF_KEYS[key]
    // The Windows tunnel service rejects a key it does not know; fail here, before anything privileged runs.
    if (!name) throw new Error(`Параметр AmneziaWG «${key}» не поддерживается`)
    if (AWG_TOGGLES.includes(key)) {
      if (awgToggleOn(value)) iface.push(line(name, 'on'))
      continue
    }
    iface.push(line(name, value))
  }

  const peer = [line('PublicKey', tunnel.peerPublicKey)]
  if (secrets.presharedKey) peer.push(line('PresharedKey', secrets.presharedKey))
  peer.push(line('AllowedIPs', tunnel.allowedIps.join(', ')))
  // Left as a name if it is one: the Windows tunnel service resolves it itself.
  peer.push(line('Endpoint', tunnel.endpoint))
  if (tunnel.keepalive) peer.push(line('PersistentKeepalive', String(tunnel.keepalive)))

  return ['[Interface]', ...iface, '', '[Peer]', ...peer, ''].join('\n')
}
