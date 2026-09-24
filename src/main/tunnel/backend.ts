import type { EngineInfo, Tunnel, TunnelStats } from '../../shared/types'
import type { Logger } from '../logger'
import type { KeyVault } from '../store'
import type { ProbeResult } from './healthCheck'
import type { DaemonTail } from './manager'
import type { TunnelController } from './TunnelController'

/** Everything the app needs from the platform's tunnel engine; index.ts picks one at start-up. */
export interface Backend {
  controller: TunnelController
  /** Follows the engine's own log so it shows up in the journal. */
  tail: DaemonTail
  /** End-to-end connectivity check; the manager's default (macOS) probe when absent. */
  probe?: (stats: () => Promise<TunnelStats>) => Promise<ProbeResult>
  /** Which amneziawg-go is in use; shown in «Об SenAWG» and written to the journal at start-up. */
  describe(): Promise<EngineInfo>
  /** Keeps the keys when the system has no keyring for safeStorage (Linux: the SenAWG service). */
  vault?: KeyVault
}

export interface BackendOptions {
  /** `resources` directory: `process.resourcesPath` when packaged, the project's own in development. */
  resources: string
  userData: string
  packaged: boolean
  logger: Logger
  diagnostics: () => boolean
  /** DNS servers for this tunnel (Настройки → DNS); the key's own list by default. */
  dnsFor: (tunnel: Tunnel) => string[]
  /** New lines of the engine's log, as written (the journal and the tunnel manager both read them). */
  daemonLines: (lines: string[]) => void
}
