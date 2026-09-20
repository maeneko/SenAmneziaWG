/**
 * The wire protocol of the Windows helper service (helper/internal/proto/proto.go): one JSON object
 * per line, one request and one response per connection.
 */
export const PROTOCOL = 1

export type HelperOp = 'hello' | 'up' | 'down' | 'status' | 'stats' | 'netinfo' | 'cleanup'

export interface HelperRequest {
  op: HelperOp
  /**
   * This process. The service stops the tunnel when this process goes away — the tunnel is a Windows
   * service with no parent, so nothing else ties it to the app. Sent on every request, so a restarted
   * app that adopts a running tunnel also re-points the watcher at itself.
   */
  pid?: number
  id?: string
  name?: string
  conf?: string
  replace?: boolean
  target?: string
}

export interface HelperResponse {
  ok: boolean
  code?: string
  error?: string
  // hello
  protocol?: number
  helper?: string
  awgGo?: string
  // up
  iface?: string
  startedAt?: number
  endpointIp?: string
  // status
  active?: { id: string; iface: string; startedAt: number }
  stale?: boolean
  // stats: the daemon's `get=1` answer, without key material
  uapi?: string
  // netinfo
  routeIface?: string
  resolver?: { iface: string; nameservers: string[] }
}

/** A failure the helper reported; the message is written for the user. */
export class HelperError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message)
  }
}
