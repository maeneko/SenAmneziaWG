import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The renderer keeps the open tab in localStorage; this module is otherwise pure.
let store: Record<string, string>
let throwing = false
vi.stubGlobal('localStorage', {
  getItem: (k: string) => {
    if (throwing) throw new Error('доступ к localStorage запрещён')
    return store[k] ?? null
  },
  setItem: (k: string, v: string) => {
    if (throwing) throw new Error('доступ к localStorage запрещён')
    store[k] = v
  }
})
const { readSettingsTab, writeSettingsTab } = await import('../src/renderer/src/lib/settingsTab')

beforeEach(() => {
  store = {}
  throwing = false
})
afterEach(() => vi.restoreAllMocks())

describe('readSettingsTab', () => {
  it('keeps the tab that was open', () => {
    for (const tab of ['interface', 'network', 'diagnostics', 'about'] as const) {
      store['awg:settingsTab'] = tab
      expect(readSettingsTab()).toBe(tab)
    }
  })

  it('sends someone who was on «Логи» to «Диагностика», not back to the first tab', () => {
    store['awg:settingsTab'] = 'logs'
    expect(readSettingsTab()).toBe('diagnostics')
  })

  it('falls back to the first tab for nothing saved or a value it does not know', () => {
    expect(readSettingsTab()).toBe('interface')
    store['awg:settingsTab'] = 'whatever'
    expect(readSettingsTab()).toBe('interface')
  })

  it('survives localStorage being unavailable', () => {
    throwing = true
    expect(readSettingsTab()).toBe('interface')
    expect(() => writeSettingsTab('about')).not.toThrow()
  })

  it('round-trips through writeSettingsTab', () => {
    writeSettingsTab('about')
    expect(readSettingsTab()).toBe('about')
  })
})
