import { describe, expect, it } from 'vitest'
import type { LogEntry } from '../src/shared/types'
import { isIpAddress, resolveDns, sanitizeUiSettings } from '../src/shared/uiSettings'
import { MAX_LOGS, collapseRepeats, filterLogs, formatTime, mergeLogs } from '../src/renderer/src/lib/logs'
import { endpointHost, formatBytes, formatUptime, pluralEntries } from '../src/renderer/src/lib/format'

const entry = (id: number, source: LogEntry['source'] = 'app'): LogEntry => ({ id, ts: 0, level: 'info', source, message: `m${id}` })

describe('mergeLogs', () => {
  it('appends new entries in id order', () => {
    expect(mergeLogs([entry(1), entry(2)], [entry(3)]).map((e) => e.id)).toEqual([1, 2, 3])
  })

  it('ignores entries it already has (a pushed batch racing the initial fetch)', () => {
    const prev = [entry(2), entry(3)]
    const merged = mergeLogs(prev, [entry(1), entry(2), entry(3)])
    expect(merged.map((e) => e.id)).toEqual([1, 2, 3])
  })

  it('returns the same array when nothing is new (no needless re-render)', () => {
    const prev = [entry(1)]
    expect(mergeLogs(prev, [entry(1)])).toBe(prev)
    expect(mergeLogs(prev, [])).toBe(prev)
  })

  it('keeps only the newest MAX_LOGS', () => {
    const many = Array.from({ length: MAX_LOGS + 3 }, (_, i) => entry(i + 1))
    const merged = mergeLogs([], many)
    expect(merged).toHaveLength(MAX_LOGS)
    expect(merged[0].id).toBe(4)
  })
})

describe('filterLogs', () => {
  const all = [entry(1, 'app'), entry(2, 'tunnel'), entry(3, 'app')]
  it('returns everything for "all"', () => expect(filterLogs(all, 'all')).toBe(all))
  it('narrows by source', () => {
    expect(filterLogs(all, 'tunnel').map((e) => e.id)).toEqual([2])
    expect(filterLogs(all, 'app').map((e) => e.id)).toEqual([1, 3])
  })
})

describe('formatTime', () => {
  it('is zero-padded local HH:MM:SS', () => {
    expect(formatTime(new Date(2026, 8, 19, 4, 5, 6).getTime())).toBe('04:05:06')
  })
})

describe('Russian plurals', () => {
  it.each([
    [0, '0 записей'], [1, '1 запись'], [2, '2 записи'], [4, '4 записи'], [5, '5 записей'],
    [11, '11 записей'], [12, '12 записей'], [21, '21 запись'], [22, '22 записи'], [111, '111 записей'], [1000, '1000 записей']
  ])('%i entries', (n, text) => expect(pluralEntries(n)).toBe(text))
})

describe('collapseRepeats', () => {
  const e = (id: number, message: string, source: LogEntry['source'] = 'tunnel', level: LogEntry['level'] = 'info'): LogEntry => ({
    id, ts: 0, level, source, message
  })

  it('folds consecutive identical lines and keeps the first id', () => {
    const runs = collapseRepeats([e(1, 'a'), e(2, 'a'), e(3, 'a')])
    expect(runs).toHaveLength(1)
    expect(runs[0].entry.id).toBe(1)
    expect(runs[0].count).toBe(3)
  })

  it('starts a new run after a different line', () => {
    expect(collapseRepeats([e(1, 'a'), e(2, 'b'), e(3, 'a')]).map((r) => r.count)).toEqual([1, 1, 1])
  })

  it('does not merge different sources or levels', () => {
    expect(collapseRepeats([e(1, 'a', 'tunnel'), e(2, 'a', 'app')])).toHaveLength(2)
    expect(collapseRepeats([e(1, 'a', 'tunnel', 'info'), e(2, 'a', 'tunnel', 'warn')])).toHaveLength(2)
  })

  it('handles an empty journal', () => expect(collapseRepeats([])).toEqual([]))
})

describe('formatUptime', () => {
  const min = 60_000
  it.each([
    [0, 'меньше минуты'], [59_000, 'меньше минуты'], [min, '1 мин'], [12 * min, '12 мин'], [59 * min, '59 мин'],
    [60 * min, '1 ч 00 мин'], [65 * min, '1 ч 05 мин'], [23 * 60 * min + 59 * min, '23 ч 59 мин'],
    [24 * 60 * min, '1 дн 0 ч'], [51 * 60 * min, '2 дн 3 ч']
  ])('%i ms → %s', (ms, text) => expect(formatUptime(1_000_000, 1_000_000 + ms)).toBe(text))

  it('never goes negative when the clock steps back', () => expect(formatUptime(5_000, 1_000)).toBe('меньше минуты'))
})

describe('formatBytes', () => {
  it('counts in thousands with Russian units by default, like Finder', () => {
    expect(formatBytes(999)).toBe('999 Б')
    expect(formatBytes(1000)).toBe('1 КБ')
    expect(formatBytes(175_500_000)).toBe('175,5 МБ')
    expect(formatBytes(2_340_000_000)).toBe('2,3 ГБ')
  })
  it('counts in 1024s when asked', () => {
    expect(formatBytes(1024, 'binary')).toBe('1 КиБ')
    expect(formatBytes(175_500_000, 'binary')).toBe('167,4 МиБ')
  })
  it('shows a dash when there is nothing to count', () => expect(formatBytes(undefined)).toBe('—'))
})

describe('sanitizeUiSettings', () => {
  it('keeps known values', () => {
    expect(sanitizeUiSettings({ traffic: 'split', units: 'binary' })).toEqual({ traffic: 'split', units: 'binary' })
  })
  it('drops unknown keys and values', () => {
    expect(sanitizeUiSettings({ traffic: 'everything', units: 1024, diagnostics: true, __proto__: { x: 1 } })).toEqual({})
    expect(sanitizeUiSettings(null)).toEqual({})
    expect(sanitizeUiSettings('total')).toEqual({})
  })
})

describe('isIpAddress', () => {
  it.each(['1.1.1.1', '149.112.112.112', '0.0.0.0', '2606:4700:4700::1111', '::1', 'fe80::1'])('accepts %s', (v) =>
    expect(isIpAddress(v)).toBe(true)
  )
  it.each(['', '1.1.1', '256.1.1.1', '01.1.1.1', '1.1.1.1:53', '1.1.1.1/32', 'dns.google', 'fe80::1%en0', '1.1.1.1; rm -rf /', ':::'])(
    'rejects %j',
    (v) => expect(isIpAddress(v)).toBe(false)
  )
})

describe('resolveDns', () => {
  const key = ['10.8.0.1']
  it('uses the key DNS when no own servers are set', () => expect(resolveDns(key, { dnsCustom: [] })).toEqual(key))
  it('uses own servers when set', () =>
    expect(resolveDns(key, { dnsCustom: ['8.8.8.8', '2001:4860:4860::8888'] })).toEqual(['8.8.8.8', '2001:4860:4860::8888']))
})

describe('sanitizeUiSettings — DNS', () => {
  it('keeps valid addresses, deduplicated and capped at two', () => {
    expect(sanitizeUiSettings({ dnsCustom: ['1.1.1.1', '1.1.1.1', '8.8.8.8', '9.9.9.9'] })).toEqual({ dnsCustom: ['1.1.1.1', '8.8.8.8'] })
  })
  it('rejects a list with anything that is not an IP (it reaches a root script)', () => {
    expect(sanitizeUiSettings({ dnsCustom: ['1.1.1.1', '1.1.1.1 && id'] })).toEqual({})
  })
  it('ignores the mode switch saved by an earlier version', () => {
    expect(sanitizeUiSettings({ dnsMode: 'quad9' })).toEqual({})
  })
})

describe('endpointHost', () => {
  it.each([
    ['203.0.113.7:51820', '203.0.113.7'],
    ['vpn.example.com:443', 'vpn.example.com'],
    ['[2001:db8::1]:51820', '2001:db8::1'],
    ['2001:db8::1', '2001:db8::1'],
    ['203.0.113.7', '203.0.113.7']
  ])('%s → %s', (endpoint, host) => expect(endpointHost(endpoint)).toBe(host))
})
