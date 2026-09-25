import type { KeyDevices } from '@shared/types'

const CACHE_KEY = 'awg:keyDevices'

/**
 * The last list of devices each master key's server gave, so the «Ключ» tab opens on it instead of on an
 * empty card and fills in the fresh one when it comes. Kept across restarts; only this computer reads it.
 */
type Fetch = (id: string) => Promise<KeyDevices>

const cache = new Map<string, KeyDevices>(readCache())
const inFlight = new Map<string, Promise<KeyDevices>>()

function readCache(): [string, KeyDevices][] {
  try {
    const saved = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}') as Record<string, KeyDevices>
    return Object.entries(saved).filter(([, v]) => Number.isFinite(v?.limit) && Array.isArray(v?.devices))
  } catch {
    return []
  }
}

function writeCache(): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(cache)))
  } catch {
    /* a convenience only: the tab still loads without it */
  }
}

export const cachedDevices = (id: string): KeyDevices | null => cache.get(id) ?? null

/** Asks the key's server for its devices and remembers the answer; one request per key at a time. */
export function loadDevices(id: string, fetch: Fetch): Promise<KeyDevices> {
  const pending = inFlight.get(id)
  if (pending) return pending
  const request = fetch(id)
    .then((info) => {
      cache.set(id, info)
      writeCache()
      return info
    })
    .finally(() => inFlight.delete(id))
  inFlight.set(id, request)
  return request
}

/** Keeps only the keys still on this computer, and fetches the lists of those not seen yet in the background. */
export function syncDevices(ids: string[], fetch: Fetch): void {
  let dropped = false
  for (const id of cache.keys()) {
    if (ids.includes(id)) continue
    cache.delete(id)
    dropped = true
  }
  if (dropped) writeCache()
  for (const id of ids) if (!cache.has(id)) void loadDevices(id, fetch).catch(() => undefined)
}
