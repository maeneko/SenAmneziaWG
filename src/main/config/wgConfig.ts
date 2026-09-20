import { randomUUID } from 'node:crypto'
import type { AwgParams, Tunnel } from '../../shared/types'
import { AWG_EXTRA_KEYS } from '../../shared/awgVersion'
import { VpnLinkError, decodeVpnLink } from './vpnLink'
import { base64ToHex } from './keys'

export interface TunnelSecrets {
  privateKey: string
  presharedKey?: string
}

export interface ParsedTunnel {
  tunnel: Tunnel
  secrets: TunnelSecrets
}

type Ini = Record<string, Record<string, string>[]>

/** Minimal INI reader for WireGuard configs; section names and keys are lowercased. */
export function parseIni(text: string): Ini {
  const out: Ini = {}
  let current: Record<string, string> | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const section = /^\[(.+)]$/.exec(line)
    if (section) {
      current = {}
      const name = section[1].trim().toLowerCase()
      ;(out[name] ??= []).push(current)
      continue
    }
    const eq = line.indexOf('=')
    if (eq === -1 || !current) continue
    current[line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim()
  }
  return out
}

const list = (v: string | undefined): string[] =>
  v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []

const int = (v: string | undefined, fallback: number): number => {
  const n = Number.parseInt(v ?? '', 10)
  return Number.isFinite(n) ? n : fallback
}

export function parseWgConfig(
  iniText: string,
  opts: { name: string; dns?: string[]; mtu?: number }
): ParsedTunnel {
  const ini = parseIni(iniText)
  const iface = ini['interface']?.[0]
  const peer = ini['peer']?.[0]
  if (!iface || !peer) throw new VpnLinkError('В конфиге нет секций [Interface] и [Peer]')

  const privateKey = iface['privatekey']
  if (!privateKey) throw new VpnLinkError('В конфиге нет приватного ключа клиента')
  const peerPublicKey = peer['publickey']
  if (!peerPublicKey) throw new VpnLinkError('В конфиге нет публичного ключа сервера')
  const endpoint = peer['endpoint']
  if (!endpoint) throw new VpnLinkError('В конфиге нет адреса сервера (Endpoint)')
  const address = iface['address']
  if (!address) throw new VpnLinkError('В конфиге нет адреса клиента (Address)')

  try {
    base64ToHex(privateKey)
    base64ToHex(peerPublicKey)
    if (peer['presharedkey']) base64ToHex(peer['presharedkey'])
  } catch {
    throw new VpnLinkError('Ключи в конфиге повреждены (ожидается base64 на 32 байта)')
  }

  const extra: Record<string, string> = {}
  for (const [k, v] of Object.entries(iface)) {
    // Accept both CamelCase (.conf) and snake_case spellings; store under the UAPI name.
    const uapiKey = AWG_EXTRA_KEYS[k.replaceAll('_', '')]
    if (uapiKey && v !== '') extra[uapiKey] = v
  }
  if (extra.header_protection_key) {
    try {
      base64ToHex(extra.header_protection_key)
    } catch {
      throw new VpnLinkError('HeaderProtectionKey повреждён (ожидается base64 на 32 байта)')
    }
  }

  const awg: AwgParams = {
    jc: int(iface['jc'], 0),
    jmin: int(iface['jmin'], 0),
    jmax: int(iface['jmax'], 0),
    s1: int(iface['s1'], 0),
    s2: int(iface['s2'], 0),
    h1: iface['h1'] ?? '1',
    h2: iface['h2'] ?? '2',
    h3: iface['h3'] ?? '3',
    h4: iface['h4'] ?? '4',
    extra
  }

  const dns = list(iface['dns'])
  const mtu = iface['mtu'] ? int(iface['mtu'], 0) : opts.mtu
  const keepalive = peer['persistentkeepalive'] ? int(peer['persistentkeepalive'], 0) : undefined

  return {
    tunnel: {
      id: randomUUID(),
      name: opts.name,
      endpoint,
      address,
      dns: dns.length ? dns : (opts.dns ?? []),
      mtu: mtu || undefined,
      allowedIps: list(peer['allowedips']).length ? list(peer['allowedips']) : ['0.0.0.0/0', '::/0'],
      peerPublicKey,
      keepalive,
      awg
    },
    secrets: { privateKey, presharedKey: peer['presharedkey'] }
  }
}

interface AmneziaContainer {
  container?: string
  [k: string]: unknown
}

function findLastConfig(container: AmneziaContainer): Record<string, unknown> | null {
  for (const value of Object.values(container)) {
    if (value && typeof value === 'object' && 'last_config' in value) {
      const raw = (value as { last_config: unknown }).last_config
      try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
        if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
      } catch {
        return null
      }
    }
  }
  return null
}

/** vpn:// link → tunnel plus its secrets. Throws VpnLinkError with a user-readable message. */
export function parseVpnLink(link: string, nameOverride?: string): ParsedTunnel {
  const root = decodeVpnLink(link)
  const containers = Array.isArray(root.containers) ? (root.containers as AmneziaContainer[]) : []
  if (!containers.length) throw new VpnLinkError('В ссылке нет ни одного контейнера с VPN')

  const isAwg = (c: AmneziaContainer): boolean =>
    typeof c.container === 'string' ? c.container.toLowerCase().includes('awg') : false
  const preferred = typeof root.defaultContainer === 'string' ? root.defaultContainer : undefined
  const ordered = [
    ...containers.filter((c) => c.container === preferred && isAwg(c)),
    ...containers.filter((c) => isAwg(c) && c.container !== preferred)
  ]

  let lastConfig: Record<string, unknown> | null = null
  for (const c of ordered) {
    lastConfig = findLastConfig(c)
    if (lastConfig) break
  }
  if (!lastConfig) throw new VpnLinkError('В ссылке нет контейнера AmneziaWG — другие протоколы не поддерживаются')

  const dns1 = typeof root.dns1 === 'string' ? root.dns1 : ''
  const dns2 = typeof root.dns2 === 'string' ? root.dns2 : ''
  const ini = typeof lastConfig.config === 'string' ? lastConfig.config : ''
  if (!ini) throw new VpnLinkError('В контейнере AmneziaWG нет текста конфига')

  const resolved = ini.replaceAll('$PRIMARY_DNS', dns1).replaceAll('$SECONDARY_DNS', dns2)
  const hostName = typeof root.hostName === 'string' ? root.hostName : ''
  const description = typeof root.description === 'string' ? root.description.trim() : ''

  return parseWgConfig(resolved, {
    name: nameOverride?.trim() || description || hostName || 'AmneziaWG',
    dns: [dns1, dns2].filter(Boolean),
    mtu: typeof lastConfig.mtu === 'string' || typeof lastConfig.mtu === 'number'
      ? int(String(lastConfig.mtu), 0) || undefined
      : undefined
  })
}
