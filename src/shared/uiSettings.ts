/** How the connection's data usage is shown under the power button. */
export type TrafficView = 'total' | 'split' | 'hidden'
/** decimal: 1 МБ = 1000 КБ, as Finder counts; binary: 1 МиБ = 1024 КиБ. */
export type ByteUnits = 'decimal' | 'binary'
/** system: follow the operating system's light/dark setting. */
export type ThemeMode = 'system' | 'light' | 'dark'

export interface UiSettings {
  traffic: TrafficView
  units: ByteUnits
  /** The user's own DNS servers, primary first. Empty: each server uses the DNS from its key. */
  dnsCustom: string[]
  /** Connect to the last used server as soon as the application starts. */
  autoConnect: boolean
  /** Check for updates and download them without being asked. Installing always waits for the user. */
  autoUpdate: boolean
  /** Windows: closing the window hides it to the notification area and the connection stays up. */
  runInBackground: boolean
  /** Linux, «Экспериментальные»: take the interface colours from pywal's palette. */
  pywal: boolean
  theme: ThemeMode
  /** How often a connected tunnel is probed end to end again, in seconds; 0 = only once, at connect. */
  recheckSec: number
}

export const UI_DEFAULTS: UiSettings = { traffic: 'total', units: 'decimal', dnsCustom: [], autoConnect: false, autoUpdate: true, runInBackground: true, pywal: false, theme: 'system', recheckSec: 60 }

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
const THEMES: readonly ThemeMode[] = ['system', 'light', 'dark']
/** «Проверка соединения»: the presets offered, and the bounds of the user's own interval (seconds). */
export const RECHECK_PRESETS: readonly number[] = [0, 30, 60, 300]
export const RECHECK_MIN = 10
export const RECHECK_MAX = 3600
export const validRecheck = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && (n === 0 || (n >= RECHECK_MIN && n <= RECHECK_MAX))
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
  if (typeof raw.autoUpdate === 'boolean') out.autoUpdate = raw.autoUpdate
  if (typeof raw.runInBackground === 'boolean') out.runInBackground = raw.runInBackground
  if (typeof raw.pywal === 'boolean') out.pywal = raw.pywal
  if (THEMES.includes(raw.theme as ThemeMode)) out.theme = raw.theme as ThemeMode
  if (validRecheck(raw.recheckSec)) out.recheckSec = raw.recheckSec
  return out
}
