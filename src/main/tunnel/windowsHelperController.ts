import type { LogLevel, Tunnel, TunnelStats } from '../../shared/types'
import { AWG_VERSION_LABEL, detectAwgVersion } from '../../shared/awgVersion'
import { buildWgConf } from '../config/wgConf'
import type { TunnelSecrets } from '../config/wgConfig'
import { binarySupports, parseBinaryVersion } from './binaryVersion'
import type { ActiveTunnel, TunnelController } from './TunnelController'
import { parseStats } from './uapi'
import { HelperClient, UP_TIMEOUT_MS } from './windows/helperClient'
import { HelperError, PROTOCOL, type HelperResponse } from './windows/protocol'

type Log = (level: LogLevel, message: string) => void

/**
 * The Windows counterpart of MacosScriptController. Nothing here is privileged: the work is done by the
 * AmnesiaWG service (helper/), which the installer registered once and which the app reaches over a
 * named pipe, so there is no admin prompt per connection and no UserCancelledError.
 */
export class WindowsHelperController implements TunnelController {
  private engine: Promise<HelperResponse> | null = null

  constructor(
    private readonly client: HelperClient,
    private readonly log: Log = () => {},
    /** DNS servers to set for this tunnel (Настройки → DNS); the key's own list by default. */
    private readonly dnsFor: (tunnel: Tunnel) => string[] = (tunnel) => tunnel.dns
  ) {}

  /** Asks the service what it is, once; refuses one that speaks another protocol (an update half done). */
  hello(): Promise<HelperResponse> {
    this.engine ??= this.client
      .request({ op: 'hello' })
      .then((res) => {
        if (res.protocol !== PROTOCOL) {
          throw new HelperError('Служба AmnesiaWG другой версии — переустановите AmnesiaWG', 'PROTOCOL')
        }
        return res
      })
      .catch((err) => {
        this.engine = null // not up yet, or replaced by a matching version since: ask again next time
        throw err
      })
    return this.engine
  }

  /** Fails fast, before anything is started, when the daemon inside the service is older than the config needs. */
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
          'Обновите AmnesiaWG'
      )
    }
  }

  async up(tunnel: Tunnel, secrets: TunnelSecrets, replace = false): Promise<ActiveTunnel> {
    await this.checkEngine(tunnel)
    const dns = this.dnsFor(tunnel)
    this.log('info', dns.length ? `DNS: ${dns.join(', ')}` : 'DNS не задан — остаётся DNS системы')
    const res = await this.client.request(
      { op: 'up', id: tunnel.id, name: tunnel.name, conf: buildWgConf(tunnel, secrets, dns), replace },
      UP_TIMEOUT_MS
    )
    return {
      id: tunnel.id,
      iface: res.iface ?? 'AmnesiaWG',
      endpointIp: res.endpointIp || undefined,
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
