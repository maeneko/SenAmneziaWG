/**
 * The wire protocol of the SenAWG helper service on Windows, Linux and macOS (helper/internal/proto/proto.go):
 * one JSON object per line, one request and one response per connection.
 */

import type { ErrorCode } from '../../../shared/errorCatalog'
import { AppError } from '../../appError'
export const PROTOCOL = 1

export type HelperOp = 'hello' | 'up' | 'down' | 'status' | 'stats' | 'netinfo' | 'cleanup' | 'secret-put' | 'secret-delete' | 'sen-sign'

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
  /** Linux only (helper/proto.Request): what awg.sh instead takes as --address/--mtu/--dns on macOS. */
  address?: string[]
  mtu?: number
  dns?: string[]
  /** Linux only, secret-put: the keys in base64, as in a .conf (helper/internal/vault). */
  privateKey?: string
  presharedKey?: string
  /** Linux only, sen-sign: the request string of the /sub/v1 protocol; the service signs it with the auth key held for `id`. */
  message?: string
  /** Linux only, up: `conf` comes without keys; the service adds the ones it keeps for `id`. */
  vault?: boolean
  /** macOS only, up: awg.sh's --diagnostics (packet capture, Logs → «Диагностика подключения»). */
  diagnostics?: boolean
  /** up: «Маршрутизация». `dns` (when given) is what the tunnel's own queries use; the helper puts its DNS proxy in front. */
  routing?: { final: 'direct' | 'proxy'; rules: { action: 'proxy' | 'direct' | 'block'; kind: string; value: string }[] }
}

export interface HelperResponse {
  ok: boolean
  code?: string
  error?: string
  // hello
  protocol?: number
  helper?: string
  awgGo?: string
  /** macOS: the installed service's build id (helper/macinstall.go: buildID; macos/service.ts). */
  build?: string
  /** The helper knows `routing` (older ones ignore it, so the app must not pretend it is applied). */
  routing?: boolean
  /** Linux: rules by program can be applied (cgroup v2 and nftables are there). */
  perApp?: boolean
  // up
  iface?: string
  startedAt?: number
  endpointIp?: string
  // status
  active?: { id: string; iface: string; startedAt: number }
  stale?: boolean
  // sen-sign: Ed25519 signature, base64url
  sig?: string
  // stats: the daemon's `get=1` answer, without key material
  uapi?: string
  // netinfo
  routeIface?: string
  resolver?: { iface: string; nameservers: string[] }
}

/**
 * A failure of the helper or of the way to it. `code` is the protocol's (NOT_RUNNING, BUSY…), what the logic goes by;
 * the window shows the catalog's text for `errorCode`, and the helper's own words go to the journal.
 */
export class HelperError extends AppError {
  constructor(
    errorCode: ErrorCode,
    readonly code: string,
    detail?: string,
    params?: Record<string, string>
  ) {
    super(errorCode, params, detail)
  }
}

/**
 * The helper's refusal as a catalog error. The helper still words its failures itself (helper/internal/proto);
 * until it sends catalog codes, its protocol code picks ours — and for SERVICE, INTERNAL and NO_SECRET, which
 * cover several cases each, its words do. They go to the journal either way.
 */
export function helperFailure(code = 'UNKNOWN', message = ''): HelperError {
  const detail = message || undefined
  const of = (errorCode: ErrorCode, params?: Record<string, string>): HelperError => new HelperError(errorCode, code, detail, params)
  switch (code) {
    case 'BUSY':
      return of('TUN-05')
    case 'CONF_INVALID':
      return of('CFG-10')
    case 'TUNNEL_DEAD':
      return of('TUN-08')
    case 'NO_TUNNEL':
      return of('TUN-06')
    case 'UAPI':
      return of('TUN-09')
    case 'NO_ACCESS':
      return of('SVC-07')
    case 'NO_SECRET':
      return of(/подписки/.test(message) ? 'KEY-18' : 'TUN-02')
    case 'INTERNAL': {
      if (/подписки в службе повреждён/.test(message)) return of('KEY-19')
      const keys = /(прочитать|сохранить|удалить) ключи/.exec(message)
      return keys ? of('SVC-14', { action: keys[1] }) : of('SVC-09')
    }
    case 'SERVICE': {
      if (/маршрутизаци|правила по программам/.test(message)) return of('RTE-17')
      if (/wintun/i.test(message)) return of('TUN-13')
      if (/amneziawg-go/.test(message)) return of('TUN-11')
      if (/интерфейс не определён/.test(message)) return of('TUN-10')
      if (/службу туннеля/.test(message)) return of('TUN-14', { action: /остановить/.test(message) ? 'остановила' : 'запустила' })
      if (/launchd|Объекты входа/.test(message)) return of('SVC-12')
      if (/установлена (не полностью|неправильно)/.test(message)) return of('SVC-11')
      return of('TUN-07')
    }
    case 'BAD_REQUEST':
      return of('SVC-15')
    default:
      return of('SVC-09')
  }
}
