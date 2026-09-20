import type { Tunnel, TunnelStats } from '../../shared/types'
import type { TunnelSecrets } from '../config/wgConfig'

export interface ActiveTunnel {
  id: string
  iface: string
  /** Resolved server address (known for tunnels started in this session). */
  endpointIp?: string
  /** Tunnel address of this client, e.g. 10.9.0.6. */
  localIp?: string
  /** When the tunnel came up (epoch ms); known for tunnels found running at start-up. */
  startedAt?: number
}

/**
 * Privileged tunnel operations. The first implementation shells out to root scripts behind an
 * admin prompt; a launchd helper can replace it without touching the rest of the app.
 */
export interface TunnelController {
  /**
   * With `replace`, a running tunnel is stopped as part of the same privileged call (server switch).
   * If bringing the new one up then fails, neither tunnel is left running.
   */
  up(tunnel: Tunnel, secrets: TunnelSecrets, replace?: boolean): Promise<ActiveTunnel>
  down(active: ActiveTunnel): Promise<void>
  stats(active: ActiveTunnel): Promise<TunnelStats>
  /** Reattach to a tunnel left running by a previous app session, if any. */
  recover(): Promise<ActiveTunnel | null>
  /** True when leftovers of a dead session (DNS, routes) are still applied but no tunnel runs. */
  hasStaleState(): Promise<boolean>
  /** Undo those leftovers. */
  cleanup(): Promise<void>
  /** Diagnostic packet capture taken right after connecting, if any. */
  readCapture?(): Promise<{ inner: string; outer: string; innerVerbose?: string } | null>
}

export class UserCancelledError extends Error {
  constructor() {
    super('Подключение отменено')
  }
}
