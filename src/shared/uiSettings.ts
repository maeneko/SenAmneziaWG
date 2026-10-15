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
  /** Linux, «Экспериментальные»: a tray icon (StatusNotifierItem: waybar's `tray`) and, with it, running in the background. */
  linuxTray: boolean
  /** Linux, «Экспериментальные»: take the interface colours from pywal's palette. */
  pywal: boolean
  theme: ThemeMode
  /** How often a connected tunnel is probed end to end again, in seconds; 0 = only once, at connect. */
  recheckSec: number
  /** «Что идёт через VPN»: off = everything; exclude = everything but the listed sites; include = only the listed sites. */
  splitMode: SplitMode
  /** Two lists, so switching the mode does not throw away the other one. Normalised by normalizeDomain. */
  splitInclude: string[]
  splitExclude: string[]
}

export const UI_DEFAULTS: UiSettings = {
  traffic: 'total',
  units: 'decimal',
  dnsCustom: [],
  autoConnect: false,
  autoUpdate: true,
  runInBackground: true,
  linuxTray: false,
  pywal: false,
  theme: 'system',
  recheckSec: 60,
  splitMode: 'off',
  splitInclude: [],
  splitExclude: []
}

export type SplitMode = 'off' | 'include' | 'exclude'

/** What the helper gets: the mode and the domains of the list that mode uses. */
export interface SplitConfig {
  mode: 'include' | 'exclude'
  domains: string[]
}

/** The same cap the helper enforces (ValidateSplit). */
export const MAX_SPLIT_DOMAINS = 500

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

const DOMAIN_CHARS = /^[\p{L}\p{N}.-]+$/u
const DOMAIN_ASCII = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/

/**
 * A site as the DNS proxy matches it: lower case, punycode, no «*.» and no trailing dot; null when it
 * is not a domain name (an address, a path, a single label such as «com»). Subdomains are covered by the
 * helper, so «example.com» and «*.example.com» mean the same.
 */
export function normalizeDomain(value: string): string | null {
  let d = value.trim().toLowerCase()
  if (d.startsWith('*.')) d = d.slice(2)
  if (d.endsWith('.')) d = d.slice(0, -1)
  if (!d || !DOMAIN_CHARS.test(d)) return null
  let host: string
  try {
    host = new URL(`http://${d}/`).hostname
  } catch {
    return null
  }
  if (host.length > 253 || !DOMAIN_ASCII.test(host)) return null
  // «1.2.3.4» is an address, not a site: the proxy never sees those.
  if (/^[0-9]+$/.test(host.slice(host.lastIndexOf('.') + 1))) return null
  return host
}

/** All entries valid → the normalised, deduplicated list; any invalid → null (the whole field is refused). */
export function normalizeDomains(list: unknown): string[] | null {
  if (!Array.isArray(list)) return null
  const out = new Set<string>()
  for (const item of list) {
    const d = typeof item === 'string' ? normalizeDomain(item) : null
    if (!d) return null
    out.add(d)
  }
  return out.size > MAX_SPLIT_DOMAINS ? null : [...out]
}

/** The split the helper should apply, or null for «everything through the VPN» (also when the list is empty). */
export function resolveSplit(settings: Pick<UiSettings, 'splitMode' | 'splitInclude' | 'splitExclude'>): SplitConfig | null {
  if (settings.splitMode === 'off') return null
  const domains = settings.splitMode === 'include' ? settings.splitInclude : settings.splitExclude
  return domains.length ? { mode: settings.splitMode, domains } : null
}

const SPLIT_MODES: readonly SplitMode[] = ['off', 'include', 'exclude']
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
  if (typeof raw.linuxTray === 'boolean') out.linuxTray = raw.linuxTray
  if (typeof raw.pywal === 'boolean') out.pywal = raw.pywal
  if (THEMES.includes(raw.theme as ThemeMode)) out.theme = raw.theme as ThemeMode
  if (validRecheck(raw.recheckSec)) out.recheckSec = raw.recheckSec
  if (SPLIT_MODES.includes(raw.splitMode as SplitMode)) out.splitMode = raw.splitMode as SplitMode
  // The domains end up in the helper's DNS matcher and routing code: only well-formed names, normalised here.
  const include = normalizeDomains(raw.splitInclude)
  if (include) out.splitInclude = include
  const exclude = normalizeDomains(raw.splitExclude)
  if (exclude) out.splitExclude = exclude
  return out
}
