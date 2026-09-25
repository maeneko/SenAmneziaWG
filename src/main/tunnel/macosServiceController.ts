import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { Tunnel, TunnelStats } from '../../shared/types'
import type { TunnelSecrets } from '../config/wgConfig'
import { DEFAULT_MTU } from '../config/wgConf'
import {
  checkBinaryFor,
  findBinary,
  hasStaleStateFile,
  type HelperLog,
  isMonitorRunning,
  readCaptureFiles,
  readStateFile,
  recoverFromState
} from './macosScriptController'
import { installService, serviceBuildId } from './macos/service'
import type { ActiveTunnel, TunnelController } from './TunnelController'
import { readStats } from './uapi'
import { buildUapiSet, splitEndpoint } from './uapiConfig'
import { type HelperClient, UP_TIMEOUT_MS } from './windows/helperClient'
import { PROTOCOL } from './windows/protocol'

/**
 * macOS through the SenAWG service (helper/*_darwin.go): the same awg.sh as MacosScriptController, run
 * as root by a launchd service instead of behind an admin prompt each time. The one prompt left installs
 * that service — on the first connection, and again only when an update brings a different one.
 *
 * Only what needs root goes through the service: up, down, cleanup. Reading what runs (recover, stats,
 * the watchdog, captures) needs none — awg.sh's state file is world-readable and the daemon's UAPI socket
 * is handed to the user — so starting the app never asks for anything, service installed or not.
 */
export class MacosServiceController implements TunnelController {
  private expectedBuild: Promise<string> | null = null

  constructor(
    private readonly client: HelperClient,
    /** Contents/Resources: what the service is installed from, and what its build id is checked against. */
    private readonly resources: string,
    private readonly bundledBinary: string,
    private readonly log: HelperLog = () => {},
    private readonly diagnostics: () => boolean = () => false,
    /** DNS servers to set for this tunnel (Настройки → DNS); the key's own list by default. */
    private readonly dnsFor: (tunnel: Tunnel) => string[] = (tunnel) => tunnel.dns,
    private readonly install: (resources: string) => Promise<void> = installService,
    private readonly buildOf: (resources: string) => Promise<string> = serviceBuildId
  ) {}

  /** The daemon this app carries — the one the service is installed with, so its version is the service's. */
  binary(): string {
    return findBinary(this.bundledBinary, true)
  }

  /**
   * Makes sure the installed service is this app's own build. `hello` alone installs it when there is
   * none (the client's starter, macos/service.ts); a service from another build — an update brought a
   * new awg.sh, daemon or helper — is replaced. A running tunnel is not touched by either: it belongs to
   * awg.sh's own processes, not to the service.
   */
  private async ensureService(): Promise<void> {
    this.expectedBuild ??= this.buildOf(this.resources).catch((err: unknown) => {
      this.expectedBuild = null
      throw err
    })
    const expected = await this.expectedBuild
    const hello = await this.client.request({ op: 'hello' })
    if (hello.protocol === PROTOCOL && hello.build === expected) return
    this.log('info', `Служба SenAWG ${hello.helper ?? ''} от другой сборки приложения — переустанавливаю`)
    await this.install(this.resources)
    const again = await this.client.request({ op: 'hello' })
    if (again.protocol !== PROTOCOL || again.build !== expected) {
      throw new Error('Служба SenAWG не обновилась — переустановите SenAWG')
    }
  }

  async up(tunnel: Tunnel, secrets: TunnelSecrets, replace = false): Promise<ActiveTunnel> {
    await checkBinaryFor(this.binary(), tunnel, this.log)
    await this.ensureService()
    const { host } = splitEndpoint(tunnel.endpoint)
    const endpointIp = isIP(host) ? host : (await lookup(host)).address
    const dns = this.dnsFor(tunnel)
    this.log('info', dns.length ? `DNS: ${dns.join(', ')}` : 'DNS не задан — остаётся DNS системы')

    const res = await this.client.request(
      {
        op: 'up',
        id: tunnel.id,
        name: tunnel.name,
        conf: buildUapiSet(tunnel, secrets, endpointIp),
        address: tunnel.address.split(',').map((a) => a.trim()),
        mtu: tunnel.mtu ?? DEFAULT_MTU,
        dns,
        replace,
        diagnostics: this.diagnostics() || undefined
      },
      UP_TIMEOUT_MS
    )
    if (!res.iface) throw new Error('Туннель запущен, но интерфейс не определён')
    return {
      id: tunnel.id,
      iface: res.iface,
      endpointIp: res.endpointIp || endpointIp,
      localIp: tunnel.address.split(',')[0].split('/')[0].trim()
    }
  }

  async down(_active: ActiveTunnel): Promise<void> {
    await this.client.request({ op: 'down' }, UP_TIMEOUT_MS)
  }

  async cleanup(): Promise<void> {
    await this.client.request({ op: 'cleanup' }, UP_TIMEOUT_MS)
  }

  stats(active: ActiveTunnel): Promise<TunnelStats> {
    return readStats(active.iface)
  }

  recover(): Promise<ActiveTunnel | null> {
    return recoverFromState()
  }

  hasStaleState(): Promise<boolean> {
    return hasStaleStateFile()
  }

  watchdogAlive(): Promise<boolean> {
    return isMonitorRunning(readStateFile()?.MONITOR_PID)
  }

  readCapture(): Promise<{ inner: string; outer: string; innerVerbose: string } | null> {
    return readCaptureFiles()
  }
}
