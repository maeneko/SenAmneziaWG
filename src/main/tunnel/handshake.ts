import type { TunnelStats } from '../../shared/types'

/** WireGuard rekeys about every 2 minutes; a handshake older than this means the peer is not answering. */
export const FRESH_HANDSHAKE_SEC = 180

export const isHandshakeFresh = (stats: TunnelStats, nowSec = Date.now() / 1000): boolean =>
  stats.lastHandshakeSec > 0 && nowSec - stats.lastHandshakeSec < FRESH_HANDSHAKE_SEC
