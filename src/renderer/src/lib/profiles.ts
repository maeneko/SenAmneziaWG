import type { Profile } from '@shared/types'

const CACHE_KEY = 'awg:profiles'

/**
 * The last answer MA7 gave for each login, so «Профиль» opens on it instead of on an empty card and fills in
 * the fresh one when it comes. Kept across restarts; only this computer reads it. `at`: epoch ms of the answer.
 */
export interface CachedProfile {
  profile: Profile
  at: number
}

type Fetch = (login: string) => Promise<Profile>

const cache = new Map<string, CachedProfile>(readCache())
const inFlight = new Map<string, Promise<CachedProfile>>()

function readCache(): [string, CachedProfile][] {
  try {
    const saved = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}') as Record<string, CachedProfile>
    return Object.entries(saved).filter(([login, v]) => v?.profile?.login === login && Number.isFinite(v.at) && Number.isFinite(v.profile.balance))
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

export const cachedProfile = (login: string): CachedProfile | null => cache.get(login) ?? null

/** Asks MA7 for the account and remembers the answer; one request per login at a time. */
export function loadProfile(login: string, fetch: Fetch): Promise<CachedProfile> {
  const pending = inFlight.get(login)
  if (pending) return pending
  const request = fetch(login)
    .then((profile) => {
      const entry = { profile, at: Date.now() }
      cache.set(login, entry)
      writeCache()
      return entry
    })
    .finally(() => inFlight.delete(login))
  inFlight.set(login, request)
  return request
}

/** Keeps only the logins still named by a master key, and fetches the accounts not seen yet in the background. */
export function syncProfiles(logins: string[], fetch: Fetch): void {
  let dropped = false
  for (const login of cache.keys()) {
    if (logins.includes(login)) continue
    cache.delete(login)
    dropped = true
  }
  if (dropped) writeCache()
  for (const login of logins) if (!cache.has(login)) void loadProfile(login, fetch).catch(() => undefined)
}
