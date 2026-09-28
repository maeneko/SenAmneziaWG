import { describe, expect, it, vi } from 'vitest'
import type { Profile } from '../src/shared/types'

// «Профиль» keeps the last accounts in localStorage, read once when the module loads.
const account = (login: string, balance = 100): Profile => ({ login, status: 'active', paidUntil: 1_800_000_000_000, balance, monthly: 300, keys: 2 })
const store: Record<string, string> = {
  'awg:profiles': JSON.stringify({
    ma7_old: { profile: account('ma7_old'), at: 1 },
    ma7_gone: { profile: account('ma7_gone'), at: 1 },
    ma7_broken: { profile: { login: 'ma7_broken' }, at: 1 },
    // Saved under one login but for another: not this account.
    ma7_other: { profile: account('ma7_else'), at: 1 }
  })
}
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => {
    store[k] = v
  }
})
const { cachedProfile, loadProfile, syncProfiles } = await import('../src/renderer/src/lib/profiles')
const saved = (): Record<string, { profile: Profile; at: number }> => JSON.parse(store['awg:profiles'])

describe('profiles cache', () => {
  it('opens on the accounts kept from before, skipping what does not read as one', () => {
    expect(cachedProfile('ma7_old')).toEqual({ profile: account('ma7_old'), at: 1 })
    expect(cachedProfile('ma7_broken')).toBeNull()
    expect(cachedProfile('ma7_other')).toBeNull()
    expect(cachedProfile('ma7_new')).toBeNull()
  })

  it('remembers a fresh answer with its time and asks only once while a request is out', async () => {
    const fetch = vi.fn(async () => account('ma7_old', 450))
    const [a, b] = await Promise.all([loadProfile('ma7_old', fetch), loadProfile('ma7_old', fetch)])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(a.at).toBeGreaterThan(1)
    expect(cachedProfile('ma7_old')?.profile.balance).toBe(450)
    expect(saved().ma7_old.profile.balance).toBe(450)
  })

  it('keeps the last account when MA7 does not answer', async () => {
    await expect(loadProfile('ma7_old', async () => Promise.reject(new Error('нет связи')))).rejects.toThrow('нет связи')
    expect(cachedProfile('ma7_old')?.profile.balance).toBe(450)
  })

  it('forgets logins no key names and fetches only the ones it has nothing for', async () => {
    const fetch = vi.fn(async (login: string) => account(login, 5))
    syncProfiles(['ma7_old', 'ma7_new'], fetch)
    expect(fetch).toHaveBeenCalledExactlyOnceWith('ma7_new')
    expect(cachedProfile('ma7_gone')).toBeNull()
    await vi.waitFor(() => expect(cachedProfile('ma7_new')?.profile.balance).toBe(5))
    expect(Object.keys(saved()).sort()).toEqual(['ma7_new', 'ma7_old'])
  })
})
