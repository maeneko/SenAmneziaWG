import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { LogLevel, Tunnel, TunnelStats } from '../../shared/types'
import type { RoutingConfig } from '../../shared/routingRules'
import { AWG_VERSION_LABEL, detectAwgVersion } from '../../shared/awgVersion'
import type { TunnelSecrets } from '../config/wgConfig'
import { DEFAULT_MTU } from '../config/wgConf'
import { binarySupports, parseBinaryVersion } from './binaryVersion'
import type { ActiveTunnel, TunnelController } from './TunnelController'
import { parseStats } from './uapi'
import { buildUapiSet, splitEndpoint } from './uapiConfig'
import { HelperClient, UP_TIMEOUT_MS } from './windows/helperClient'
import { HelperError, PROTOCOL, type HelperResponse } from './windows/protocol'

type Log = (level: LogLevel, message: string) => void

/** The routing to send, or undefined when none is set or the service is too old to apply it. */
export async function routingToSend(
  want: () => RoutingConfig | null,
  hello: HelperResponse,
  log: Log
): Promise<RoutingConfig | undefined> {
  let routing = want()
  if (!routing) return undefined
  if (!hello.routing) {
    log('warn', 'Служба SenAWG старой версии не умеет маршрутизацию по правилам — всё идёт через VPN. Обновите SenAWG')
    return undefined
  }
  // Rules by program need cgroup v2 and nftables in the service's system; without them they are left out, said so.
  const byApp = (r: { kind: string }): boolean => r.kind === 'processName' || r.kind === 'processPath'
  if (!hello.perApp && routing.rules.some(byApp)) {
    log('warn', 'Правила по программам не применены: службе нужны cgroup v2 и nftables')
    const rules = routing.rules.filter((r) => !byApp(r))
    if (rules.length === 0) return undefined
    routing = { ...routing, rules }
  }
  const by = (a: string): number => routing.rules.filter((r) => r.action === a).length
  log(
    'info',
    `Маршрутизация: по умолчанию ${routing.final === 'direct' ? 'напрямую' : 'через VPN'}, правил: через VPN ${by('proxy')}, напрямую ${by('direct')}, блок ${by('block')}`
  )
  return routing
}

/** A well-formed stand-in for buildUapiSet when the service holds the real key; its line is dropped. */
const PLACEHOLDER_KEY = Buffer.alloc(32).toString('base64')

/**
 * The UAPI body without key lines, for keys the service keeps (helper/internal/vault): the service puts
 * them back in the same places (proto.InjectSecrets), so they never come back to this process.
 */
function uapiWithoutKeys(tunnel: Tunnel, endpointIp: string): string {
  return buildUapiSet(tunnel, { privateKey: PLACEHOLDER_KEY }, endpointIp)
    .split('\n')
    .filter((line) => !line.startsWith('private_key=') && !line.startsWith('preshared_key='))
    .join('\n')
}

/**
 * The Linux counterpart of MacosScriptController and WindowsHelperController. Like Windows, nothing
 * here is privileged: the work is done by the SenAWG service (helper/, this time driving a bundled
 * amneziawg-go over its own UAPI socket instead of amneziawg-windows), reached over a Unix socket. Like
 * macOS, the app resolves the endpoint and builds the UAPI body itself (buildUapiSet) — there is no
 * amneziawg-windows tunnel.Run here to hand a whole .conf to.
 */
export class LinuxHelperController implements TunnelController {
  private engine: Promise<HelperResponse> | null = null

  constructor(
    private readonly client: HelperClient,
    private readonly log: Log = () => {},
    /** DNS servers to set for this tunnel (Настройки → DNS); the key's own list by default. */
    private readonly dnsFor: (tunnel: Tunnel) => string[] = (tunnel) => tunnel.dns,
    private readonly routingWanted: () => RoutingConfig | null = () => null
  ) {}

  hello(): Promise<HelperResponse> {
    this.engine ??= this.client
      .request({ op: 'hello' })
      .then((res) => {
        if (res.protocol !== PROTOCOL) {
          throw new HelperError('Служба SenAWG другой версии — переустановите SenAWG', 'PROTOCOL')
        }
        return res
      })
      .catch((err) => {
        this.engine = null
        throw err
      })
    return this.engine
  }

  private async checkEngine(tunnel: Tunnel): Promise<void> {
    const hello = await this.hello()
    const version = parseBinaryVersion(`amneziawg-go ${hello.awgGo ?? ''}`)
    if (!version) {
      this.log('warn', `Не удалось определить версию amneziawg-go в службе (${hello.awgGo ?? '?'})`)
      return
    }
    const needed = detectAwgVersion(tunnel.awg)
    if (!binarySupports(version, needed)) {
      throw new Error(
        `Конфиг ${AWG_VERSION_LABEL[needed]}, а amneziawg-go ${version.raw} в службе его не поддерживает. ` +
          'Обновите SenAWG'
      )
    }
  }

  async up(tunnel: Tunnel, secrets: TunnelSecrets, replace = false): Promise<ActiveTunnel> {
    await this.checkEngine(tunnel)
    const { host } = splitEndpoint(tunnel.endpoint)
    const endpointIp = isIP(host) ? host : (await lookup(host)).address
    const dns = this.dnsFor(tunnel)
    this.log('info', dns.length ? `DNS: ${dns.join(', ')}` : 'DNS не задан — остаётся DNS системы')
    const routing = await routingToSend(this.routingWanted, await this.hello(), this.log)

    const res = await this.client.request(
      {
        op: 'up',
        id: tunnel.id,
        name: tunnel.name,
        conf: secrets.heldByService ? uapiWithoutKeys(tunnel, endpointIp) : buildUapiSet(tunnel, secrets, endpointIp),
        vault: secrets.heldByService || undefined,
        address: tunnel.address.split(',').map((a) => a.trim()),
        mtu: tunnel.mtu ?? DEFAULT_MTU,
        dns,
        routing,
        replace
      },
      UP_TIMEOUT_MS
    )
    return {
      id: tunnel.id,
      iface: res.iface ?? 'senawg0',
      endpointIp: res.endpointIp || endpointIp,
      localIp: tunnel.address.split(',')[0].split('/')[0].trim()
    }
  }

  async down(_active: ActiveTunnel): Promise<void> {
    await this.client.request({ op: 'down' })
  }

  async stats(_active: ActiveTunnel): Promise<TunnelStats> {
    return parseStats((await this.client.request({ op: 'stats' })).uapi ?? '')
  }

  async recover(): Promise<ActiveTunnel | null> {
    const { active } = await this.client.request({ op: 'status' })
    return active ? { id: active.id, iface: active.iface, startedAt: active.startedAt || undefined } : null
  }

  async hasStaleState(): Promise<boolean> {
    return (await this.client.request({ op: 'status' })).stale === true
  }

  async cleanup(): Promise<void> {
    await this.client.request({ op: 'cleanup' })
  }
}
