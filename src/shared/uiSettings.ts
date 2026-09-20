/** How the connection's data usage is shown under the power button. */
export type TrafficView = 'total' | 'split' | 'hidden'
/** decimal: 1 МБ = 1000 КБ, as Finder counts; binary: 1 МиБ = 1024 КиБ. */
export type ByteUnits = 'decimal' | 'binary'

export interface UiSettings {
  traffic: TrafficView
  units: ByteUnits
  /** The user's own DNS servers, primary first. Empty: each server uses the DNS from its key. */
  dnsCustom: string[]
  /** Connect to the last used server as soon as the application starts. */
  autoConnect: boolean
}

export const UI_DEFAULTS: UiSettings = { traffic: 'total', units: 'decimal', dnsCustom: [], autoConnect: false }

/** Primary and secondary, as the settings form offers. */
export const MAX_CUSTOM_DNS = 2

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

/**
 * A plain IPv4 or IPv6 address: no port, prefix or zone. IPv6 is checked by the WHATWG URL parser,
 * which exists in both main and the renderer and is exact about the format.
 */
export function isIpAddress(value: string): boolean {
  if (IPV4.test(value)) return true
  if (!value.includes(':') || !/^[0-9A-Fa-f:.]+$/.test(value)) return false
  try {
    new URL(`http://[${value}]/`)
    return true
  } catch {
    return false
  }
}

/**
 * DNS servers the tunnel should set: the user's own when given, otherwise the key's, so a
 * connection never ends up without DNS.
 */
export function resolveDns(configDns: string[], settings: Pick<UiSettings, 'dnsCustom'>): string[] {
  const custom = settings.dnsCustom.filter(isIpAddress)
  return custom.length ? custom : configDns
}

const TRAFFIC: readonly TrafficView[] = ['total', 'split', 'hidden']
const UNITS: readonly ByteUnits[] = ['decimal', 'binary']

/** Keeps only known keys with allowed values: the renderer is not trusted to write settings.json. */
export function sanitizeUiSettings(input: unknown): Partial<UiSettings> {
  if (typeof input !== 'object' || input === null) return {}
  const raw = input as Record<string, unknown>
  const out: Partial<UiSettings> = {}
  if (TRAFFIC.includes(raw.traffic as TrafficView)) out.traffic = raw.traffic as TrafficView
  if (UNITS.includes(raw.units as ByteUnits)) out.units = raw.units as ByteUnits
  // These addresses reach a root script as arguments: only well-formed IPs, never anything else.
  if (Array.isArray(raw.dnsCustom) && raw.dnsCustom.every((v) => typeof v === 'string' && isIpAddress(v))) {
    out.dnsCustom = [...new Set(raw.dnsCustom as string[])].slice(0, MAX_CUSTOM_DNS)
  }
  if (typeof raw.autoConnect === 'boolean') out.autoConnect = raw.autoConnect
  return out
}
