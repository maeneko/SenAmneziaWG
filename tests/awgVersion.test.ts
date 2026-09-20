import { describe, expect, it } from 'vitest'
import type { AwgParams } from '../src/shared/types'
import { AWG_VERSION_LABEL, detectAwgVersion } from '../src/shared/awgVersion'
import { parseWgConfig } from '../src/main/config/wgConfig'
import { buildUapiSet } from '../src/main/tunnel/uapiConfig'

const base: AwgParams = { jc: 0, jmin: 0, jmax: 0, s1: 0, s2: 0, h1: '1', h2: '2', h3: '3', h4: '4', extra: {} }
const v = (over: Partial<AwgParams>): string => detectAwgVersion({ ...base, ...over })

describe('detectAwgVersion', () => {
  it('plain WireGuard when nothing is obfuscated', () => expect(v({})).toBe('wireguard'))

  it.each<[string, Partial<AwgParams>]>([
    ['jc only', { jc: 4 }],
    ['S1/S2 padding', { s1: 60, s2: 100 }],
    ['custom single headers', { h1: '1234567' }],
    ['I1 signature packet (1.5)', { extra: { i1: '<r 128>' } }]
  ])('legacy (1.5): %s', (_, over) => expect(v(over)).toBe('legacy'))

  it.each<[string, Partial<AwgParams>]>([
    ['S3/S4', { jc: 4, extra: { s3: '20' } }],
    ['H1 range', { jc: 4, h1: '100000-200000' }],
    ['range with I1', { h2: '5-9', extra: { i1: '<r 128>' } }]
  ])('2.0: %s', (_, over) => expect(v(over)).toBe('2.0'))

  it.each(['header_protection_key', 'content_padding_addition', 'rekey_after_time', 'keepalive_timeout', 'max_handshake_attempts'])(
    '3.0: %s',
    (key) => expect(v({ extra: { s3: '20', [key]: 'x' } })).toBe('3.0')
  )

  it.each(['random_trailers', 'disable_cookies'])('3.1: %s', (key) =>
    expect(v({ extra: { header_protection_key: 'x', [key]: 'true' } })).toBe('3.1')
  )

  it.each(['on', 'On', '1', 'yes', 't'])('3.1 switch reads %j as on (Amnezia writes on/off)', (value) =>
    expect(v({ extra: { header_protection_key: 'x', random_trailers: value } })).toBe('3.1')
  )

  it('a switch that is off does not need a 3.1 daemon', () =>
    expect(v({ extra: { header_protection_key: 'x', random_trailers: 'off', disable_cookies: 'off' } })).toBe('3.0'))

  it('has a label for every version', () => {
    expect(AWG_VERSION_LABEL.legacy).toBe('Legacy (1.5)')
    expect(AWG_VERSION_LABEL['3.1']).toBe('AmneziaWG 3.1')
  })

  it('labels the whole third generation «AmneziaWG 3.1», as the Amnezia app does', () => {
    // A key with only 3.0-era parameters (Amnezia's defaults) is «version 3.1» in Amnezia.
    expect(AWG_VERSION_LABEL[v({ extra: { s3: '37', content_padding_addition: '10-100' } }) as '3.0']).toBe('AmneziaWG 3.1')
  })
})

describe('3.x config keys (regression: CamelCase keys were dropped)', () => {
  const key = (n: number): string => Buffer.alloc(32, n).toString('base64')
  const ini = `[Interface]
Address = 10.8.1.2/32
PrivateKey = ${key(1)}
Jc = 4
S1 = 60
S2 = 100
S3 = 20
S4 = 10
H1 = 100000-200000
I1 = <r 128>
HeaderProtectionKey = ${key(9)}
ContentPaddingAddition = 0-64
RekeyAfterTime = 110-130
MaxHandshakeAttempts = 5
RandomTrailers = on
disable_cookies = true

[Peer]
PublicKey = ${key(2)}
Endpoint = 203.0.113.7:51820
`
  const { tunnel, secrets } = parseWgConfig(ini, { name: 'x' })

  it('stores every extension under its UAPI name', () => {
    expect(tunnel.awg.extra).toEqual({
      s3: '20',
      s4: '10',
      i1: '<r 128>',
      header_protection_key: key(9),
      content_padding_addition: '0-64',
      rekey_after_time: '110-130',
      max_handshake_attempts: '5',
      random_trailers: 'on',
      disable_cookies: 'true'
    })
    expect(tunnel.awg.h1).toBe('100000-200000')
  })

  it('is detected as 3.1', () => expect(detectAwgVersion(tunnel.awg)).toBe('3.1'))

  it('sends them to amneziawg-go, with header ranges intact', () => {
    const body = buildUapiSet(tunnel, secrets, '203.0.113.7')
    for (const line of ['s3=20', 's4=10', 'h1=100000-200000', `header_protection_key=${Buffer.alloc(32, 9).toString('hex')}`, 'random_trailers=1', 'disable_cookies=1']) {
      expect(body).toContain(line)
    }
    // device keys must precede the peer section
    expect(body.indexOf('disable_cookies')).toBeLessThan(body.indexOf('public_key='))
  })

  it('leaves switches that are off out (amneziawg-go only takes booleans, and off is its default)', () => {
    const off = parseWgConfig(ini.replace('RandomTrailers = on', 'RandomTrailers = off'), { name: 'x' })
    const body = buildUapiSet(off.tunnel, off.secrets, '203.0.113.7')
    expect(body).not.toContain('random_trailers')
    expect(body).toContain('disable_cookies=1')
    expect(body).not.toMatch(/=(on|off)$/m)
  })

  it('ignores unknown keys', () => {
    const t = parseWgConfig(ini.replace('Jc = 4', 'Jc = 4\nSomethingNew = 1'), { name: 'x' }).tunnel
    expect(t.awg.extra).not.toHaveProperty('somethingnew')
  })
})
