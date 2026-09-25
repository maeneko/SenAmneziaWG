import { randomUUID } from 'node:crypto'
import type { SenAddr } from '../config/senLink'
import type { SubscriptionStatus } from '../../shared/types'
import { readData, writeData } from '../store'

const FILE = 'subscriptions.json'

/** One server of a master key, as the subscription endpoint describes it. */
export interface SenServerConfig {
  id: number
  name: string
  endpoint: string
  server_pub: string
  psk: string
  /** «10.9.0.5/32» */
  address: string
  dns: string[]
  /** «25» or, for 3.1, a range like «25-35». */
  keepalive: string
  mtu?: number
  gen: string
  /** Obfuscation parameters under their .conf names; no empty values. */
  awg: Record<string, string>
}

/** The answer of GET /sub/v1/config (and of register and rekey), after its signature has been checked. */
export interface SenConfig {
  rev: string
  rekey: boolean
  endpoints: string[]
  servers: SenServerConfig[]
}

/**
 * A master key on this device. Public facts only: the auth key is in the secret store under `authKeyId`,
 * each tunnel's WireGuard keys under the tunnel's id, and the preshared keys with them — none of that is
 * here, which is also why the last config is not kept (it carries the preshared keys).
 */
export interface Subscription {
  id: string
  /** sha256(signPub ‖ secret), hex: recognises the same link pasted twice without keeping the secret. */
  linkId: string
  name: string
  /** Where the link pointed: the fallback when `endpoints` (from the last config) are all unreachable. */
  addrs: SenAddr[]
  tls: boolean
  /** base64 */
  tlsPin?: string
  /** base64 */
  signPub: string
  /** The server's number for this device (X-Sen-Device). */
  device: number
  /** Last `ts` sent; the next one is above it, so a retried request never repeats a signature. */
  lastTs: number
  /** The rev the tunnels were built from. A different one from the server means the settings changed. */
  appliedRev: string
  /** «host:port» from the last config, tried before the link's own addresses. */
  endpoints: string[]
  status: SubscriptionStatus
  checkedAt: number
  /**
   * server id → the tunnel that shows it. `pskHash` (sha256, hex) stands in for the preshared key when the
   * Linux service holds the keys and the app cannot read the old one back to see that it changed.
   */
  tunnels: Record<number, { tunnelId: string; pskHash: string }>
}

/** Where the auth key is kept: the same secret store as the tunnel keys, and the ids the service accepts. */
export const authKeyId = (subId: string): string => `sen-${subId}`

export const newSubscriptionId = (): string => randomUUID()

export function listSubscriptions(): Subscription[] {
  return readData<Subscription[]>(FILE, [])
}

export function getSubscription(id: string): Subscription | undefined {
  return listSubscriptions().find((s) => s.id === id)
}

export function saveSubscription(sub: Subscription): void {
  const all = listSubscriptions()
  const i = all.findIndex((s) => s.id === sub.id)
  if (i === -1) all.push(sub)
  else all[i] = sub
  writeData(FILE, all)
}

export function deleteSubscription(id: string): void {
  writeData(FILE, listSubscriptions().filter((s) => s.id !== id))
}
