import { connect } from 'node:net'
import type { TunnelStats } from '../../shared/types'

export const UAPI_DIR = '/var/run/amneziawg'
export const socketPath = (iface: string): string => `${UAPI_DIR}/${iface}.sock`

/** One request/response round trip over the amneziawg-go UAPI unix socket. */
export function uapiRequest(iface: string, body: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect({ path: socketPath(iface) })
    let data = ''
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error('UAPI: нет ответа от amneziawg-go'))
    }, timeoutMs)

    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(body))
    sock.on('data', (chunk: string) => {
      data += chunk
      // Responses end with a blank line after errno=N.
      if (/errno=-?\d+\n\n$/.test(data)) {
        clearTimeout(timer)
        sock.end()
        resolve(data)
      }
    })
    sock.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    sock.on('close', () => {
      clearTimeout(timer)
      if (data) resolve(data)
    })
  })
}

export function parseUapi(response: string): { device: Record<string, string>; peers: Record<string, string>[] } {
  const device: Record<string, string> = {}
  const peers: Record<string, string>[] = []
  let peer: Record<string, string> | null = null
  for (const line of response.split('\n')) {
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1)
    if (key === 'public_key') {
      peer = { public_key: value }
      peers.push(peer)
    } else if (peer) {
      peer[key] = value
    } else {
      device[key] = value
    }
  }
  return { device, peers }
}

/** A `get=1` response → the counters the UI shows. Shared by every backend: they differ in how they fetch it. */
export function parseStats(response: string): TunnelStats {
  const peer = parseUapi(response).peers[0]
  return {
    rxBytes: Number(peer?.rx_bytes ?? 0),
    txBytes: Number(peer?.tx_bytes ?? 0),
    lastHandshakeSec: Number(peer?.last_handshake_time_sec ?? 0)
  }
}

export async function readStats(iface: string): Promise<TunnelStats> {
  return parseStats(await uapiRequest(iface, 'get=1\n\n'))
}
