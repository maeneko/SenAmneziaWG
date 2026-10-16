import { describe, expect, it } from 'vitest'
import { isIpAddress, normalizeDomain, parseIpOrCidr } from '../src/shared/netNames'
import { ROUTING_EXAMPLES } from '../src/shared/routingExamples'
import {
  MAX_ROUTING_RULES,
  ROUTING_DEFAULTS,
  migrateLegacySplit,
  parseRouting,
  parseRoutingLine,
  parseRoutingText,
  resolveRouting,
  routingKey,
  routingSummary,
  rulesFromLists,
  listsFromSimple,
  parseSites,
  MAX_ADVANCED_RULES,
  sanitizeRouting,
  unsupportedRules,
  type AdvancedRule,
  type RoutingSettings
} from '../src/shared/routingRules'
import { UI_DEFAULTS, sanitizeUiSettings } from '../src/shared/uiSettings'

// Most of these are about the lists, so that is the mode they get.
const routing = (patch: Partial<RoutingSettings> = {}): RoutingSettings => ({ ...ROUTING_DEFAULTS, mode: 'lists', ...patch })

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

describe('parseIpOrCidr', () => {
  it('accepts an address, a network, IPv6', () => {
    expect(parseIpOrCidr('93.184.216.34')).toEqual({ ok: true, value: '93.184.216.34' })
    expect(parseIpOrCidr('10.0.0.0/8')).toEqual({ ok: true, value: '10.0.0.0/8' })
    expect(parseIpOrCidr('2001:DB8::/32')).toEqual({ ok: true, value: '2001:db8::/32' })
  })

  it('refuses networks wide enough to take over the routing table, and non-addresses', () => {
    for (const bad of ['0.0.0.0/0', '10.0.0.0/7', '::/0', '2000::/8', '10.0.0.0/33', '10.0.0.0/x', 'example.com', '300.1.1.1', '10.0.0.0/']) {
      expect(parseIpOrCidr(bad).ok, bad).toBe(false)
    }
    expect(isIpAddress('1.1.1.1')).toBe(true)
  })
})

describe('parseRoutingLine', () => {
  const line = (s: string): unknown => parseRoutingLine(s)

  it('reads each prefix, in any case', () => {
    expect(line('domain:Nura.eco')).toEqual({ rule: { kind: 'domain', value: 'nura.eco' } })
    expect(line('suffix:ozon.ru')).toEqual({ rule: { kind: 'suffix', value: 'ozon.ru' } })
    expect(line('SUFFIX: ozon.ru ')).toEqual({ rule: { kind: 'suffix', value: 'ozon.ru' } })
    expect(line('keyword:AdService')).toEqual({ rule: { kind: 'keyword', value: 'adservice' } })
    expect(line('regex:\\.(ru|su)$')).toEqual({ rule: { kind: 'regex', value: '\\.(ru|su)$' } })
    expect(line('ip:10.0.0.0/8')).toEqual({ rule: { kind: 'ip', value: '10.0.0.0/8' } })
    expect(line('ip:2001:db8::/32')).toEqual({ rule: { kind: 'ip', value: '2001:db8::/32' } })
    expect(line('processName:Telegram')).toEqual({ rule: { kind: 'processName', value: 'Telegram' } })
    expect(line('processname:Google Chrome')).toEqual({ rule: { kind: 'processName', value: 'Google Chrome' } })
    expect(line('processPath:/usr/bin/spotify')).toEqual({ rule: { kind: 'processPath', value: '/usr/bin/spotify' } })
    expect(line('ruleset:geoip-ru')).toEqual({ rule: { kind: 'ruleset', value: 'geoip-ru' } })
  })

  it('a line without a prefix is a site with its subdomains, or an address/network', () => {
    expect(line('example.com')).toEqual({ rule: { kind: 'suffix', value: 'example.com' } })
    expect(line('*.example.com')).toEqual({ rule: { kind: 'suffix', value: 'example.com' } })
    expect(line('93.184.216.34')).toEqual({ rule: { kind: 'ip', value: '93.184.216.34' } })
    expect(line('192.168.0.0/16')).toEqual({ rule: { kind: 'ip', value: '192.168.0.0/16' } })
  })

  it('blank lines and comments are nothing', () => {
    expect(line('')).toEqual({ rule: null })
    expect(line('   ')).toEqual({ rule: null })
    expect(line('# банки напрямую')).toEqual({ rule: null })
  })

  it('says what is wrong', () => {
    const err = (s: string): string => parseRoutingLine(s).error ?? ''
    expect(err('colour:red')).toMatch(/Неизвестный префикс «colour:»/)
    expect(err('2001:db8::1')).toMatch(/Неизвестный префикс/) // IPv6 needs ip:
    expect(err('suffix:com')).toMatch(/доменное имя/)
    expect(err('domain:1.2.3.4')).toMatch(/доменное имя/)
    expect(err('keyword:a')).toMatch(/Ключевое слово/)
    expect(err('regex:(')).toMatch(/Некорректное регулярное/)
    expect(err('regex:(?=a)b')).toMatch(/RE2/)
    expect(err('regex:(a)\\1')).toMatch(/RE2/)
    expect(err('regex:' + 'a'.repeat(257))).toMatch(/до 256/)
    expect(err('ip:0.0.0.0/0')).toMatch(/слишком широкая/)
    expect(err('ip:example.com')).toMatch(/IP-адрес/)
    expect(err('processName:/usr/bin/spotify')).toMatch(/без пути/)
    expect(err('processPath:spotify')).toMatch(/полный/)
    expect(err('ruleset:whatever')).toMatch(/geoip-ru/)
  })
})

describe('parseRoutingText', () => {
  it('numbers lines from 1, keeps going after an error, drops duplicates', () => {
    const { rules, errors } = parseRoutingText('suffix:a.com\n# note\nbad:x\n\nsuffix:A.com\ndomain:a.com\nsuffix:b.org', 'direct')
    expect(rules).toEqual([
      { action: 'direct', kind: 'suffix', value: 'a.com' },
      { action: 'direct', kind: 'domain', value: 'a.com' },
      { action: 'direct', kind: 'suffix', value: 'b.org' }
    ])
    expect(errors).toEqual([{ line: 3, text: 'bad:x', message: expect.stringMatching(/Неизвестный префикс/) }])
  })

  it('handles Windows line endings', () => {
    expect(parseRoutingText('suffix:a.com\r\nsuffix:b.com\r\n', 'proxy').rules).toHaveLength(2)
  })
})

describe('parseRouting and resolveRouting', () => {
  const settings = routing({ final: 'direct', proxy: 'suffix:vpn.example', direct: 'suffix:home.example', block: 'suffix:ads.example\nip:10.0.0.0/8' })

  it('rules come in the order they are matched: proxy, direct, block', () => {
    expect(parseRouting(settings).rules.map((r) => r.action)).toEqual(['proxy', 'direct', 'block', 'block'])
    // The order of the fields in the settings object does not matter.
    const shuffled = { ...settings, block: settings.block, direct: settings.direct, proxy: settings.proxy }
    expect(parseRouting(shuffled).rules.map((r) => r.action)).toEqual(['proxy', 'direct', 'block', 'block'])
  })

  it('is null without rules (everything through the VPN), whatever the default says', () => {
    expect(resolveRouting(routing())).toBeNull()
    expect(resolveRouting(routing({ final: 'direct' }))).toBeNull()
    expect(resolveRouting(routing({ proxy: '# only a comment' }))).toBeNull()
  })

  it('carries the default and the rules', () => {
    expect(resolveRouting(settings)).toEqual({ final: 'direct', rules: parseRouting(settings).rules })
  })

  it('leaves out what this platform cannot do, and says what', () => {
    const mixed = routing({ proxy: 'processName:spotify\nsuffix:a.com\nruleset:geoip-ru' })
    expect(resolveRouting(mixed)?.rules.map((r) => r.kind)).toEqual(['suffix'])
    expect(resolveRouting(mixed, { process: true, ruleset: true })?.rules.map((r) => r.kind)).toEqual(['processName', 'suffix', 'ruleset'])
    const un = unsupportedRules(parseRouting(mixed).rules, { process: false, ruleset: false })
    expect(un.map((u) => u.rule.kind)).toEqual(['processName', 'ruleset'])
    // Only unsupported lines: nothing to send.
    expect(resolveRouting(routing({ proxy: 'processName:spotify' }))).toBeNull()
  })

  it('a line that stopped parsing is skipped, not sent', () => {
    expect(resolveRouting(routing({ proxy: 'suffix:a.com\nbad:x' }))?.rules).toHaveLength(1)
  })
})

describe('routingSummary and routingKey', () => {
  it('names the profile and counts the rules the helper will get', () => {
    expect(routingSummary(routing())).toEqual({ text: 'Всё через VPN', on: false })
    expect(routingSummary(routing({ name: 'Работа', direct: 'suffix:a.com' }))).toEqual({ text: 'Работа · 1 правило', on: true })
    expect(routingSummary(routing({ direct: 'suffix:a.com\nsuffix:b.com' })).text).toBe('Default · 2 правила')
    expect(routingSummary(routing({ direct: Array.from({ length: 5 }, (_, i) => `suffix:h${i}.com`).join('\n') })).text).toBe('Default · 5 правил')
    expect(routingSummary(routing({ direct: Array.from({ length: 11 }, (_, i) => `suffix:h${i}.com`).join('\n') })).text).toBe('Default · 11 правил')
    expect(routingSummary(routing({ direct: Array.from({ length: 21 }, (_, i) => `suffix:h${i}.com`).join('\n') })).text).toBe('Default · 21 правило')
    // Only what this platform cannot do: nothing in force.
    expect(routingSummary(routing({ proxy: 'processName:x' })).on).toBe(false)
  })

  it('the key changes with the default or any list, not with the name', () => {
    const base = routingKey(routing({ proxy: 'a', direct: 'b' }))
    expect(routingKey(routing({ proxy: 'a', direct: 'b', name: 'Другое' }))).toBe(base)
    expect(routingKey(routing({ proxy: 'a', direct: 'b', final: 'direct' }))).not.toBe(base)
    expect(routingKey(routing({ proxy: 'a2', direct: 'b' }))).not.toBe(base)
    expect(routingKey(routing({ proxy: 'a', direct: 'b', block: 'c' }))).not.toBe(base)
  })
})

describe('sanitizeRouting', () => {
  it('keeps valid lists as typed, with the name cleaned', () => {
    const input = { name: '  Дом\u0000\n ', final: 'direct', proxy: '# моё\nsuffix:a.com', direct: '', block: 'domain:x.org' }
    expect(sanitizeRouting({ ...input, mode: 'lists' })).toEqual({ name: 'Дом', mode: 'lists', simple: ROUTING_DEFAULTS.simple, final: 'direct', proxy: '# моё\nsuffix:a.com', direct: '', block: 'domain:x.org', rules: [] })
    expect(sanitizeRouting({ ...input, name: '   ' })?.name).toBe('Default')
    expect(sanitizeRouting({ ...input, name: 'я'.repeat(100) })?.name).toHaveLength(64)
  })

  it('refuses the whole thing when anything is off', () => {
    const ok = { name: 'a', final: 'proxy', proxy: '', direct: '', block: '' }
    expect(sanitizeRouting(ok)).not.toBeNull()
    expect(sanitizeRouting(null)).toBeNull()
    expect(sanitizeRouting('x')).toBeNull()
    expect(sanitizeRouting({ ...ok, final: 'block' })).toBeNull()
    expect(sanitizeRouting({ ...ok, proxy: 'colour:red' })).toBeNull()
    expect(sanitizeRouting({ ...ok, direct: 5 })).toBeNull()
    expect(sanitizeRouting({ ...ok, block: undefined })).toBeNull()
    const many = Array.from({ length: MAX_ROUTING_RULES + 1 }, (_, i) => `suffix:h${i}.example.com`).join('\n')
    expect(sanitizeRouting({ ...ok, proxy: many })).toBeNull()
    expect(sanitizeRouting({ ...ok, proxy: many.split('\n').slice(0, MAX_ROUTING_RULES).join('\n') })).not.toBeNull()
  })
})

describe('settings migration', () => {
  it('«only the list» becomes the simple mode\'s «only»', () => {
    expect(migrateLegacySplit({ splitMode: 'include', splitInclude: ['youtube.com', 'Netflix.com'], splitExclude: ['x.com'] })).toEqual({
      ...ROUTING_DEFAULTS, simple: { kind: 'only', sites: 'youtube.com\nnetflix.com' }
    })
  })

  it('«everything but the list» becomes the simple mode\'s «except»', () => {
    expect(migrateLegacySplit({ splitMode: 'exclude', splitInclude: [], splitExclude: ['ozon.ru'] })).toEqual({
      ...ROUTING_DEFAULTS, simple: { kind: 'except', sites: 'ozon.ru' }
    })
  })

  it('off, an empty list or junk is no routing', () => {
    expect(migrateLegacySplit({ splitMode: 'off', splitInclude: ['a.com'] })).toBeNull()
    expect(migrateLegacySplit({ splitMode: 'exclude', splitExclude: [] })).toBeNull()
    expect(migrateLegacySplit({ splitMode: 'exclude', splitExclude: ['nope'] })).toBeNull()
    expect(migrateLegacySplit({})).toBeNull()
  })

  it('an old settings.json is read as routing; a new one wins over the old keys', () => {
    expect(sanitizeUiSettings({ splitMode: 'exclude', splitExclude: ['ozon.ru'] }).routing).toMatchObject({ mode: 'simple', simple: { kind: 'except', sites: 'ozon.ru' } })
    const both = sanitizeUiSettings({ splitMode: 'exclude', splitExclude: ['ozon.ru'], routing: { name: 'N', mode: 'lists', final: 'direct', proxy: 'suffix:a.com', direct: '', block: '' } })
    expect(both.routing).toMatchObject({ name: 'N', mode: 'lists', final: 'direct' })
    // A routing that does not parse is dropped, not replaced by the old keys.
    expect(sanitizeUiSettings({ splitMode: 'exclude', splitExclude: ['ozon.ru'], routing: { final: 'x' } }).routing).toBeUndefined()
  })

  it('defaults: nothing routed, everything through the VPN', () => {
    expect(UI_DEFAULTS.routing).toEqual(ROUTING_DEFAULTS)
    expect(resolveRouting(UI_DEFAULTS.routing)).toBeNull()
  })
})

describe('the examples in the help and in docs/routing.md', () => {
  it('every line of every example parses', () => {
    for (const e of ROUTING_EXAMPLES) {
      const { errors } = parseRouting(routing(e.routing))
      expect(errors.proxy.concat(errors.direct, errors.block), e.title).toEqual([])
      expect(sanitizeRouting({ name: e.title, ...e.routing }), e.title).not.toBeNull()
    }
  })
})

describe('the rules view of the advanced mode', () => {
  const adv = (rules: Partial<AdvancedRule>[], patch: Partial<RoutingSettings> = {}): RoutingSettings =>
    routing({ mode: 'rules', rules: rules.map((r, i) => ({ name: `R${i}`, action: 'direct', lines: '', enabled: true, ...r })), ...patch })

  it('rules come in the user\'s own order, not proxy, direct, block', () => {
    const s = adv([
      { action: 'block', lines: 'suffix:ads.example.com' },
      { action: 'proxy', lines: 'suffix:example.com\nip:10.0.0.0/8' },
      { action: 'direct', lines: 'domain:shop.example.com' }
    ])
    expect(parseRouting(s).rules.map((r) => `${r.action}:${r.kind}`)).toEqual(['block:suffix', 'proxy:suffix', 'proxy:ip', 'direct:domain'])
    expect(resolveRouting(s)?.rules.map((r) => r.action)).toEqual(['block', 'proxy', 'proxy', 'direct'])
  })

  it('the lists are ignored while the rules are in force, and the rules while the lists are', () => {
    const both = routing({ mode: 'rules', proxy: 'suffix:simple.example', rules: [{ name: 'A', action: 'direct', lines: 'suffix:adv.example', enabled: true }] })
    expect(parseRouting(both).rules).toEqual([{ action: 'direct', kind: 'suffix', value: 'adv.example' }])
    expect(parseRouting({ ...both, mode: 'lists' }).rules).toEqual([{ action: 'proxy', kind: 'suffix', value: 'simple.example' }])
  })

  it('a rule that is switched off stays in the list but is not applied', () => {
    const s = adv([{ lines: 'suffix:a.com', enabled: false }, { lines: 'suffix:b.com' }])
    expect(parseRouting(s).rules.map((r) => r.value)).toEqual(['b.com'])
    expect(parseRouting(s).ruleErrors).toHaveLength(2)
    expect(resolveRouting(adv([{ lines: 'suffix:a.com', enabled: false }]))).toBeNull()
  })

  it('errors are per rule, with the line number inside it', () => {
    const s = adv([{ lines: 'suffix:a.com' }, { lines: '# note\nbad:x' }])
    const { ruleErrors } = parseRouting(s)
    expect(ruleErrors[0]).toEqual([])
    expect(ruleErrors[1]).toEqual([{ line: 2, text: 'bad:x', message: expect.stringMatching(/Неизвестный префикс/) }])
  })

  it('switching to the rules starts from the three lists: one rule for each that has lines', () => {
    expect(rulesFromLists({ proxy: 'suffix:a.com', direct: '  \n', block: 'suffix:b.com' })).toEqual([
      { name: 'Через VPN', action: 'proxy', lines: 'suffix:a.com', enabled: true },
      { name: 'Блокировать', action: 'block', lines: 'suffix:b.com', enabled: true }
    ])
    expect(rulesFromLists({ proxy: '', direct: '', block: '' })).toEqual([])
  })

  it('the key follows the mode in force', () => {
    const base = adv([{ lines: 'suffix:a.com' }])
    expect(routingKey(base)).toBe(routingKey({ ...base, proxy: 'suffix:other.com' })) // the lists do not count now
    expect(routingKey({ ...base, mode: 'lists' })).not.toBe(routingKey(base))
    expect(routingKey(adv([{ lines: 'suffix:a.com', enabled: false }]))).not.toBe(routingKey(base))
    expect(routingKey(adv([{ lines: 'suffix:a.com', action: 'proxy' }]))).not.toBe(routingKey(base))
    expect(routingKey(adv([{ lines: 'suffix:a.com', name: 'другое' }]))).toBe(routingKey(base)) // a name changes nothing
  })

  it('the summary counts the rules of the mode in force', () => {
    expect(routingSummary(adv([{ lines: 'suffix:a.com\nsuffix:b.com' }, { lines: 'suffix:c.com' }], { name: 'Работа' }))).toEqual({ text: 'Работа · 3 правила', on: true })
  })

  it('is stored whole: names cleaned, defaults filled, and anything that does not parse refuses the lot', () => {
    const ok = sanitizeRouting({ final: 'proxy', mode: 'rules', proxy: '', direct: '', block: '', rules: [{ name: ' \u0000 ', action: 'direct', lines: 'suffix:a.com' }, { action: 'block', lines: '', enabled: false }] })
    expect(ok?.mode).toBe('rules')
    expect(ok?.rules).toEqual([
      { name: 'Правило 1', action: 'direct', lines: 'suffix:a.com', enabled: true },
      { name: 'Правило 2', action: 'block', lines: '', enabled: false }
    ])
    const base = { final: 'proxy', proxy: '', direct: '', block: '' }
    expect(sanitizeRouting({ ...base, mode: 'rules', rules: [{ action: 'direct', lines: 'bad:x' }] })).toBeNull()
    expect(sanitizeRouting({ ...base, mode: 'lists', rules: [{ action: 'direct', lines: 'bad:x' }] })).toBeNull() // the idle view is checked too
    expect(sanitizeRouting({ ...base, rules: [{ action: 'reject', lines: '' }] })).toBeNull()
    expect(sanitizeRouting({ ...base, rules: [{ action: 'direct', lines: '', enabled: 'yes' }] })).toBeNull()
    expect(sanitizeRouting({ ...base, rules: 'x' })).toBeNull()
    expect(sanitizeRouting({ ...base, rules: [5] })).toBeNull()
    expect(sanitizeRouting({ ...base, mode: 'weird' })?.mode).toBe('simple')
    expect(sanitizeRouting({ ...base, mode: 'lists' })?.mode).toBe('lists')
    const tooMany = Array.from({ length: MAX_ADVANCED_RULES + 1 }, () => ({ action: 'direct', lines: '' }))
    expect(sanitizeRouting({ ...base, rules: tooMany })).toBeNull()
    expect(sanitizeRouting({ ...base, rules: tooMany.slice(0, MAX_ADVANCED_RULES) })).not.toBeNull()
    const lines = Array.from({ length: MAX_ROUTING_RULES + 1 }, (_, i) => `suffix:h${i}.example.com`).join('\n')
    expect(sanitizeRouting({ ...base, rules: [{ action: 'direct', lines }] })).toBeNull()
  })
})

describe('the simple mode: only sites', () => {
  const simple = (kind: 'only' | 'except' | 'block', sites: string, patch: Partial<RoutingSettings> = {}): RoutingSettings =>
    ({ ...ROUTING_DEFAULTS, mode: 'simple', simple: { kind, sites }, ...patch })

  it('reads a site per line, links, commas, www and case', () => {
    const { sites, errors } = parseSites('Example.com\nhttps://www.Youtube.com/watch?v=1\nhttps://user@shop.example.org:8443/a, ozon.ru ozone.ru\n*.cdn.net\n# note\n\nexample.com')
    expect(errors).toEqual([])
    expect(sites).toEqual(['example.com', 'www.youtube.com', 'shop.example.org', 'ozon.ru', 'ozone.ru', 'cdn.net'])
  })

  it('only sites: a prefix or something that is no site is an error, with its line', () => {
    const { errors } = parseSites('a.com\nsuffix:b.com\ncom\nip:10.0.0.0/8\n1.2.3.4\nprocessName:x')
    expect(errors.map((e) => [e.line, e.text])).toEqual([[2, 'suffix:b.com'], [3, 'com'], [4, 'ip:10.0.0.0/8'], [5, '1.2.3.4'], [6, 'processName:x']])
    expect(errors[0].message).toMatch(/префиксы — в продвинутом/)
    expect(errors[1].message).toMatch(/Не похоже на сайт/)
  })

  it('the three kinds: only the sites through the VPN, everything but them, or the sites blocked', () => {
    expect(resolveRouting(simple('only', 'a.com\nb.com'))).toEqual({ final: 'direct', rules: [{ action: 'proxy', kind: 'suffix', value: 'a.com' }, { action: 'proxy', kind: 'suffix', value: 'b.com' }] })
    expect(resolveRouting(simple('except', 'a.com'))).toEqual({ final: 'proxy', rules: [{ action: 'direct', kind: 'suffix', value: 'a.com' }] })
    expect(resolveRouting(simple('block', 'a.com'))).toEqual({ final: 'proxy', rules: [{ action: 'block', kind: 'suffix', value: 'a.com' }] })
  })

  it('the lists and the rules are not used while it is in force, and it is not used while they are', () => {
    const s = simple('except', 'a.com', { proxy: 'suffix:lists.example', rules: [{ name: 'r', action: 'block', lines: 'suffix:rules.example', enabled: true }] })
    expect(parseRouting(s).rules.map((r) => r.value)).toEqual(['a.com'])
    expect(parseRouting({ ...s, mode: 'lists' }).rules.map((r) => r.value)).toEqual(['lists.example'])
    expect(parseRouting({ ...s, mode: 'rules' }).rules.map((r) => r.value)).toEqual(['rules.example'])
  })

  it('no sites: everything through the VPN', () => {
    expect(resolveRouting(simple('only', ''))).toBeNull()
    expect(routingSummary(simple('only', ' \n# nothing'))).toEqual({ text: 'Всё через VPN', on: false })
  })

  it('the chip says what it does and how many sites', () => {
    expect(routingSummary(simple('only', 'a.com')).text).toBe('Только 1 сайт')
    expect(routingSummary(simple('except', 'a.com\nb.com')).text).toBe('Кроме 2 сайта')
    expect(routingSummary(simple('block', Array.from({ length: 5 }, (_, i) => `h${i}.com`).join('\n'))).text).toBe('Блок 5 сайтов')
    expect(routingSummary(simple('except', Array.from({ length: 11 }, (_, i) => `h${i}.com`).join('\n'))).text).toBe('Кроме 11 сайтов')
  })

  it('the key follows the kind and the sites, not the name or the other views', () => {
    const base = routingKey(simple('except', 'a.com'))
    expect(routingKey(simple('except', 'a.com', { name: 'другое', proxy: 'x' }))).toBe(base)
    expect(routingKey(simple('only', 'a.com'))).not.toBe(base)
    expect(routingKey(simple('except', 'a.com\nb.com'))).not.toBe(base)
  })

  it('is stored whole: a bad kind or a site that is not one refuses the lot', () => {
    const base = { final: 'proxy', proxy: '', direct: '', block: '' }
    expect(sanitizeRouting({ ...base, simple: { kind: 'block', sites: 'a.com' } })?.simple).toEqual({ kind: 'block', sites: 'a.com' })
    expect(sanitizeRouting({ ...base, simple: { kind: 'all', sites: 'a.com' } })).toBeNull()
    expect(sanitizeRouting({ ...base, simple: { kind: 'only', sites: 'suffix:a.com' } })).toBeNull()
    expect(sanitizeRouting({ ...base, simple: { kind: 'only' } })).toBeNull()
    expect(sanitizeRouting({ ...base, simple: 'x' })).toBeNull()
    expect(sanitizeRouting(base)?.simple).toEqual(ROUTING_DEFAULTS.simple)
  })

  it('opening the advanced mode for the first time carries the sites over, as suffix lines in the list their kind names', () => {
    expect(listsFromSimple(simple('only', 'a.com\nb.com'))).toEqual({ final: 'direct', proxy: 'suffix:a.com\nsuffix:b.com', direct: '', block: '' })
    expect(listsFromSimple(simple('except', 'a.com'))).toEqual({ final: 'proxy', proxy: '', direct: 'suffix:a.com', block: '' })
    expect(listsFromSimple(simple('block', 'a.com'))).toEqual({ final: 'proxy', proxy: '', direct: '', block: 'suffix:a.com' })
    // Lists that already have something are not overwritten; no sites, nothing to carry.
    expect(listsFromSimple(simple('only', 'a.com', { direct: 'suffix:x.com' }))).toBeNull()
    expect(listsFromSimple(simple('only', ''))).toBeNull()
  })
})
