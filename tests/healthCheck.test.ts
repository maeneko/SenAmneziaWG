import { describe, expect, it } from 'vitest'
import { MACOS, WINDOWS, buildDnsQuery, describeProbe, isDnsAnswer, parsePrimaryResolver, parsePrimaryResolverIface, parseRouteInterface, type ProbeResult } from '../src/main/tunnel/healthCheck'

describe('parseRouteInterface', () => {
  it('reads the interface line', () => {
    expect(parseRouteInterface('   route to: 1.1.1.1\ndestination: 0.0.0.0\n  interface: utun7\n      flags: <UP>')).toBe('utun7')
  })
  it('is null when there is no route', () => expect(parseRouteInterface('route: writing to routing socket: not in table')).toBeNull())
})

describe('parsePrimaryResolverIface', () => {
  // Shape of real `scutil --dns` output from this Mac.
  const scutil = `DNS configuration

resolver #1
  nameserver[0] : 1.1.1.1
  if_index : 22 (utun4)
  flags    : Supplemental, Request A records
  order    : 102200

resolver #2
  nameserver[0] : 1.1.1.1
  if_index : 22 (utun4)
  flags    : Request A records
  order    : 200000

resolver #3
  flags    : Request A records
  order    : 300000
`
  it('skips supplemental resolvers and takes the first real one', () => expect(parsePrimaryResolverIface(scutil)).toBe('utun4'))
  it('reports "default" for an unscoped resolver', () =>
    expect(parsePrimaryResolverIface('resolver #1\n  nameserver[0] : 192.168.1.1\n  flags : Request A records\n')).toBe('default'))
})

const base: ProbeResult = { routeIface: 'utun7', resolverIface: 'default', tcp: 'ok', tcpMs: 42, dns: 'ok', rxDelta: 5000, txDelta: 900 }
const textFor = (os: typeof MACOS, p: Partial<ProbeResult>): string =>
  describeProbe({ ...base, ...p }, 'utun7', os).map((l) => `${l.level}: ${l.message}`).join('\n')
// The default label follows the platform the tests run on; pin it so they read the same everywhere.
const text = (p: Partial<ProbeResult>): string => textFor(MACOS, p)

describe('describeProbe', () => {
  it('healthy tunnel', () => {
    expect(text({})).toBe('info: Проверка связи: 1.1.1.1:443 доступен через туннель за 42 мс\ninfo: Проверка DNS: имена разрешаются')
  })
  it('names the resolver macOS uses and flags an unreachable one', () => {
    const out = text({ resolver: { iface: 'en0', nameservers: ['1.1.1.1', '1.0.0.1'], reachable: false } })
    expect(out).toMatch(/macOS использует 1\.1\.1\.1, 1\.0\.0\.1 \(интерфейс en0, macOS помечает его недоступным\)/)
  })
  it('DNS server answers directly but the system resolver fails → local config', () =>
    expect(text({ dns: 'fail', udpDns: 'ok', udpDnsServer: '1.1.1.1' })).toMatch(/отвечает через туннель, но системный резолвер/))
  it('TCP works, UDP/53 does not → UDP filtered', () =>
    expect(text({ dns: 'fail', udpDns: 'timeout', udpDnsServer: '1.1.1.1' })).toMatch(/режет UDP\/53/))
  it('slow resolver is a warning, not an error', () =>
    expect(text({ dnsAfterSec: 4 })).toMatch(/warn: .*только через 4 с/))
  it('traffic bypasses the tunnel', () => {
    const out = text({ routeIface: 'en0' })
    expect(out).toMatch(/error: .*через en0, а не через туннель utun7/)
    expect(out).toMatch(/доступен через en0, в обход туннеля/)
  })
  it('another VPN owns DNS', () => expect(text({ resolverIface: 'utun4' })).toMatch(/warn: .*привязан к utun4/))
  it('server swallows traffic (handshake ok, no replies)', () =>
    expect(text({ tcp: 'timeout', rxDelta: 0, txDelta: 600 })).toMatch(/уходят на сервер, но ответа нет.*другом устройстве/))
  it('nothing enters the tunnel', () => expect(text({ tcp: 'timeout', rxDelta: 0, txDelta: 0 })).toMatch(/не уходят в туннель/))
  it('DNS broken', () => expect(text({ dns: 'fail' })).toMatch(/error: Проверка DNS: имена не разрешаются/))
})

describe('describeProbe on Windows', () => {
  it('names Windows, not macOS', () => {
    const out = textFor(WINDOWS, { resolver: { iface: 'Wi-Fi', nameservers: ['1.1.1.1'], reachable: true }, dns: 'fail', udpDns: 'ok', udpDnsServer: '1.1.1.1' })
    expect(out).toMatch(/Windows использует 1\.1\.1\.1 \(интерфейс Wi-Fi\)/)
    expect(out).toMatch(/системный резолвер Windows имена не разрешает/)
    expect(out).toMatch(/на этом компьютере/)
    expect(out).not.toMatch(/macOS|Mac\b/)
  })
  it('says the same about routes', () => expect(textFor(WINDOWS, { tcp: 'timeout', rxDelta: 0, txDelta: 0 })).toMatch(/маршрутами на этом компьютере/))
})

describe('parsePrimaryResolver', () => {
  it('reads nameservers, interface and reachability, ignoring the scoped section', () => {
    const out = `DNS configuration

resolver #1
  nameserver[0] : 1.1.1.1
  nameserver[1] : 1.0.0.1
  if_index : 11 (en0)
  flags    : Request A records
  reach    : 0x00000000 (Not Reachable)

DNS configuration (for scoped queries)

resolver #1
  nameserver[0] : 9.9.9.9
  if_index : 11 (en0)
  flags    : Scoped, Request A records
`
    expect(parsePrimaryResolver(out)).toEqual({ iface: 'en0', nameservers: ['1.1.1.1', '1.0.0.1'], reachable: false })
  })
})

describe('DNS packet', () => {
  it('builds a standard A query', () => {
    const q = buildDnsQuery(0x1234, 'example.com')
    expect(q.subarray(0, 12).toString('hex')).toBe('123401000001000000000000')
    expect(q.subarray(12).toString('hex')).toBe('076578616d706c6503636f6d0000010001')
  })
  it('accepts only a matching, successful answer', () => {
    const ok = Buffer.from('123481800001000100000000', 'hex')
    expect(isDnsAnswer(ok, 0x1234)).toBe(true)
    expect(isDnsAnswer(ok, 0x9999)).toBe(false)
    expect(isDnsAnswer(Buffer.from('123481830001000000000000', 'hex'), 0x1234)).toBe(false) // NXDOMAIN
  })
})
