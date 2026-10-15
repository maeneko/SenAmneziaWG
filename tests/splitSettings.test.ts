import { describe, expect, it } from 'vitest'
import { MAX_SPLIT_DOMAINS, UI_DEFAULTS, normalizeDomain, normalizeDomains, resolveSplit, sanitizeUiSettings } from '../src/shared/uiSettings'

describe('normalizeDomain', () => {
  it('lower-cases, strips «*.» and a trailing dot, trims', () => {
    expect(normalizeDomain('  Example.COM ')).toBe('example.com')
    expect(normalizeDomain('*.example.com')).toBe('example.com')
    expect(normalizeDomain('example.com.')).toBe('example.com')
    expect(normalizeDomain('www.a-b.example.co.uk')).toBe('www.a-b.example.co.uk')
  })

  it('turns international names into punycode', () => {
    expect(normalizeDomain('пример.рф')).toBe('xn--e1afmkfd.xn--p1ai')
    expect(normalizeDomain('Яндекс.рф')).toBe('xn--d1acpjx3f.xn--p1ai')
  })

  it('refuses what is not a site name', () => {
    for (const bad of ['', ' ', 'com', 'localhost', '1.2.3.4', '10.0.0.0/8', 'a b.com', 'a.com/path', 'http://a.com', 'a.com:443', 'a@b.com',
      '-a.com', 'a-.com', 'a..com', '.com', 'a\n.com', `${'a'.repeat(64)}.com`, `${'a.'.repeat(130)}com`, 'a_b.com', '[::1]']) {
      expect(normalizeDomain(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('agrees with what the helper accepts (helper/internal/proto ValidDomain)', () => {
    const ok = normalizeDomain('1c.ru')
    expect(ok).toBe('1c.ru')
    expect(ok).toMatch(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)
  })
})

describe('normalizeDomains', () => {
  it('normalises and deduplicates', () => {
    expect(normalizeDomains(['Example.com', '*.example.com', 'b.org'])).toEqual(['example.com', 'b.org'])
  })

  it('refuses the whole list when one entry is bad, or it is too long, or not a list', () => {
    expect(normalizeDomains(['example.com', 'nope'])).toBeNull()
    expect(normalizeDomains(['example.com', 5])).toBeNull()
    expect(normalizeDomains('example.com')).toBeNull()
    const many = Array.from({ length: MAX_SPLIT_DOMAINS + 1 }, (_, i) => `h${i}.example.com`)
    expect(normalizeDomains(many)).toBeNull()
    expect(normalizeDomains(many.slice(0, MAX_SPLIT_DOMAINS))).toHaveLength(MAX_SPLIT_DOMAINS)
  })
})

describe('resolveSplit', () => {
  const base = { splitMode: 'off' as const, splitInclude: ['a.com'], splitExclude: ['b.com'] }

  it('is null while the mode is off, and when the list for the mode is empty', () => {
    expect(resolveSplit(base)).toBeNull()
    expect(resolveSplit({ ...base, splitMode: 'include', splitInclude: [] })).toBeNull()
    expect(resolveSplit({ ...base, splitMode: 'exclude', splitExclude: [] })).toBeNull()
  })

  it('takes the list of the mode in use', () => {
    expect(resolveSplit({ ...base, splitMode: 'include' })).toEqual({ mode: 'include', domains: ['a.com'] })
    expect(resolveSplit({ ...base, splitMode: 'exclude' })).toEqual({ mode: 'exclude', domains: ['b.com'] })
  })
})

describe('sanitizeUiSettings: split', () => {
  it('keeps a valid mode and normalised lists', () => {
    expect(sanitizeUiSettings({ splitMode: 'exclude', splitExclude: ['Bank.RU', 'bank.ru'], splitInclude: ['a.com'] })).toEqual({
      splitMode: 'exclude',
      splitExclude: ['bank.ru'],
      splitInclude: ['a.com']
    })
  })

  it('drops an unknown mode and a list with anything bad in it', () => {
    expect(sanitizeUiSettings({ splitMode: 'all' })).toEqual({})
    expect(sanitizeUiSettings({ splitInclude: ['a.com', '$(reboot)'], splitExclude: 'a.com' })).toEqual({})
  })

  it('defaults: off, both lists empty', () => {
    expect(UI_DEFAULTS).toMatchObject({ splitMode: 'off', splitInclude: [], splitExclude: [] })
  })
})
