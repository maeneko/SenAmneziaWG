import { describe, expect, it } from 'vitest'
import { decodeVpnLink, encodeVpnLink } from '../src/main/config/vpnLink'
import { parseVpnLink } from '../src/main/config/wgConfig'
import { base64ToHex, hexToBase64 } from '../src/main/config/keys'

const KEY_A = Buffer.alloc(32, 1).toString('base64')
const KEY_B = Buffer.alloc(32, 2).toString('base64')
const PSK = Buffer.alloc(32, 3).toString('base64')

const INI = `[Interface]
Address = 10.8.1.2/32
DNS = $PRIMARY_DNS, $SECONDARY_DNS
PrivateKey = ${KEY_A}
Jc = 4
Jmin = 10
Jmax = 50
S1 = 60
S2 = 100
H1 = 1234567
H2 = 2345678
H3 = 3456789
H4 = 4567890

[Peer]
PublicKey = ${KEY_B}
PresharedKey = ${PSK}
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = 203.0.113.7:51820
PersistentKeepalive = 25
`

const sample = {
  hostName: '203.0.113.7',
  description: 'My server',
  dns1: '1.1.1.1',
  dns2: '1.0.0.1',
  defaultContainer: 'amnezia-awg',
  containers: [
    { container: 'amnezia-xray', xray: { last_config: '{}' } },
    { container: 'amnezia-awg', awg: { last_config: JSON.stringify({ config: INI, mtu: '1280', port: '51820' }) } }
  ]
}

describe('vpn:// link', () => {
  it('round-trips encode/decode', () => {
    expect(decodeVpnLink(encodeVpnLink(sample))).toEqual(sample)
  })

  it('accepts padded and standard-alphabet base64', () => {
    const link = encodeVpnLink(sample)
    const std = 'vpn://' + Buffer.from(link.slice(6), 'base64url').toString('base64')
    expect(decodeVpnLink(std)).toEqual(sample)
  })

  it('falls back to plain base64 JSON', () => {
    const link = 'vpn://' + Buffer.from(JSON.stringify({ a: 1 })).toString('base64url')
    expect(decodeVpnLink(link)).toEqual({ a: 1 })
  })

  it.each([
    ['not-a-link', /vpn:\/\//],
    ['vpn://', /нет данных/],
    ['vpn://!!!', /недопустимые/],
    ['vpn://aGVsbG8', /не похоже/]
  ])('rejects %s with a readable message', (input, message) => {
    expect(() => decodeVpnLink(input)).toThrow(message)
  })
})

describe('parseVpnLink', () => {
  it('extracts tunnel, awg params and secrets', () => {
    const { tunnel, secrets } = parseVpnLink(encodeVpnLink(sample))
    expect(tunnel.name).toBe('My server')
    expect(tunnel.endpoint).toBe('203.0.113.7:51820')
    expect(tunnel.address).toBe('10.8.1.2/32')
    expect(tunnel.dns).toEqual(['1.1.1.1', '1.0.0.1'])
    expect(tunnel.mtu).toBe(1280)
    expect(tunnel.keepalive).toBe(25)
    expect(tunnel.allowedIps).toEqual(['0.0.0.0/0', '::/0'])
    expect(tunnel.awg).toMatchObject({ jc: 4, jmin: 10, jmax: 50, s1: 60, s2: 100, h1: '1234567', h4: '4567890' })
    expect(secrets).toEqual({ privateKey: KEY_A, presharedKey: PSK })
    expect(JSON.stringify(tunnel)).not.toContain(KEY_A)
  })

  it('honors a name override', () => {
    expect(parseVpnLink(encodeVpnLink(sample), '  Home  ').tunnel.name).toBe('Home')
  })

  it('reports a missing awg container', () => {
    const link = encodeVpnLink({ containers: [{ container: 'amnezia-xray', xray: { last_config: '{}' } }] })
    expect(() => parseVpnLink(link)).toThrow(/AmneziaWG/)
  })

  it('reports empty containers', () => {
    expect(() => parseVpnLink(encodeVpnLink({ containers: [] }))).toThrow(/контейнера/)
  })

  it('rejects malformed keys', () => {
    const bad = { ...sample, containers: [{ container: 'amnezia-awg', awg: { last_config: JSON.stringify({ config: INI.replace(KEY_A, 'short') }) } }] }
    expect(() => parseVpnLink(encodeVpnLink(bad))).toThrow(/Ключи/)
  })
})

describe('keys', () => {
  it('converts base64 to 64-char hex and back', () => {
    const hex = base64ToHex(KEY_A)
    expect(hex).toHaveLength(64)
    expect(hexToBase64(hex)).toBe(KEY_A)
  })

  it('rejects wrong-length keys', () => {
    expect(() => base64ToHex('AAAA')).toThrow()
  })
})
