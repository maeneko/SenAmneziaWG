import type { ByteUnits } from '@shared/uiSettings'

const UNITS: Record<ByteUnits, { base: number; names: string[] }> = {
  decimal: { base: 1000, names: ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'] },
  binary: { base: 1024, names: ['Б', 'КиБ', 'МиБ', 'ГиБ', 'ТиБ'] }
}
const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1, minimumFractionDigits: 0 })

export function formatBytes(bytes: number | undefined, units: ByteUnits = 'decimal'): string {
  if (bytes === undefined) return '—'
  const { base, names } = UNITS[units]
  let value = bytes
  let unit = 0
  while (value >= base && unit < names.length - 1) {
    value /= base
    unit++
  }
  return `${number.format(unit === 0 ? value : Math.round(value * 10) / 10)} ${names[unit]}`
}

/** Russian plural: 1 туннель, 2–4 туннеля, 5+ туннелей (11–14 are always "many"). */
function plural(n: number, [one, few, many]: [string, string, string]): string {
  const mod100 = n % 100
  const mod10 = n % 10
  if (mod100 >= 11 && mod100 <= 14) return `${n} ${many}`
  if (mod10 === 1) return `${n} ${one}`
  if (mod10 >= 2 && mod10 <= 4) return `${n} ${few}`
  return `${n} ${many}`
}

export const pluralEntries = (n: number): string => plural(n, ['запись', 'записи', 'записей'])

/** Connection age as a short Russian phrase: «меньше минуты», «12 мин», «1 ч 05 мин», «2 дн 3 ч». */
export function formatUptime(sinceMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - sinceMs) / 60_000))
  if (minutes < 1) return 'меньше минуты'
  if (minutes < 60) return `${minutes} мин`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} ч ${String(minutes % 60).padStart(2, '0')} мин`
  return `${Math.floor(hours / 24)} дн ${hours % 24} ч`
}

/** Host part of an endpoint, without the port: `203.0.113.7:51820` → `203.0.113.7`, `[2001:db8::1]:51820` → `2001:db8::1`. */
export function endpointHost(endpoint: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(endpoint)
  if (bracketed) return bracketed[1]
  const colon = endpoint.lastIndexOf(':')
  // More than one colon without brackets: a bare IPv6 address with no port to strip.
  return colon > 0 && endpoint.indexOf(':') === colon ? endpoint.slice(0, colon) : endpoint
}
