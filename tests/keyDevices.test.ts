import { describe, expect, it, vi } from 'vitest'
import type { KeyDevices } from '../src/shared/types'

// The «Ключ» tab keeps the last lists in localStorage, read once when the module loads.
const list = (n: number, limit = 5): KeyDevices => ({
  limit,
  devices: Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `d${i}`, platform: 'macos', version: '', createdAt: 0, lastSeen: null, current: i === 0 }))
})
const store: Record<string, string> = {
  'awg:keyDevices': JSON.stringify({ old: list(2), gone: list(1), broken: { limit: 'x' } })
}
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => {
    store[k] = v
  }
})
const { cachedDevices, loadDevices, syncDevices } = await import('../src/renderer/src/lib/keyDevices')
const saved = (): Record<string, KeyDevices> => JSON.parse(store['awg:keyDevices'])

describe('key devices cache', () => {
  it('opens on the lists kept from before, skipping what does not read as one', () => {
    expect(cachedDevices('old')).toEqual(list(2))
    expect(cachedDevices('broken')).toBeNull()
    expect(cachedDevices('new')).toBeNull()
  })

  it('remembers a fresh answer and asks only once while a request is out', async () => {
    const fetch = vi.fn(async () => list(3))
    const [a, b] = await Promise.all([loadDevices('old', fetch), loadDevices('old', fetch)])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(cachedDevices('old')).toEqual(list(3))
    expect(saved().old).toEqual(list(3))
  })

  it('keeps the last list when the server does not answer', async () => {
    await expect(loadDevices('old', async () => Promise.reject(new Error('нет связи')))).rejects.toThrow('нет связи')
    expect(cachedDevices('old')).toEqual(list(3))
  })

  it('forgets removed keys and fetches only the ones it has nothing for', async () => {
    const fetch = vi.fn(async () => list(1, 2))
    syncDevices(['old', 'new'], fetch)
    expect(fetch).toHaveBeenCalledExactlyOnceWith('new')
    expect(cachedDevices('gone')).toBeNull()
    await vi.waitFor(() => expect(cachedDevices('new')).toEqual(list(1, 2)))
    expect(Object.keys(saved()).sort()).toEqual(['new', 'old'])
  })
})
