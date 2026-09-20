import { describe, expect, it } from 'vitest'
import type { Tunnel } from '../src/shared/types'
import { buildUapiSet, splitEndpoint } from '../src/main/tunnel/uapiConfig'
import { parseUapi } from '../src/main/tunnel/uapi'
import { isHandshakeFresh } from '../src/main/tunnel/handshake'

const KEY = (n: number): string => Buffer.alloc(32, n).toString('base64')
const HEX = (n: number): string => Buffer.alloc(32, n).toString('hex')

const tunnel: Tunnel = {
  id: 't1',
  name: 'Test',
  endpoint: 'vpn.example.com:51820',
  address: '10.8.1.2/32',
  dns: ['1.1.1.1'],
  allowedIps: ['0.0.0.0/0', '::/0'],
  peerPublicKey: KEY(2),
  keepalive: 25,
  awg: { jc: 4, jmin: 10, jmax: 50, s1: 60, s2: 100, h1: '1234567', h2: '2', h3: '3', h4: '4567890', extra: {} }
}

describe('buildUapiSet', () => {
  const body = buildUapiSet(tunnel, { privateKey: KEY(1), presharedKey: KEY(3) }, '203.0.113.7')
  const lines = body.trim().split('\n')

  it('starts with set=1 and ends with a blank line', () => {
    expect(lines[0]).toBe('set=1')
    expect(body.endsWith('\n\n')).toBe(true)
  })

  it('sends keys as hex', () => {
    expect(lines).toContain(`private_key=${HEX(1)}`)
    expect(lines).toContain(`public_key=${HEX(2)}`)
    expect(lines).toContain(`preshared_key=${HEX(3)}`)
  })

  it('puts device keys before the peer', () => {
    const idx = (k: string): number => lines.findIndex((l) => l.startsWith(k))
    expect(idx('private_key')).toBeLessThan(idx('jc'))
    expect(idx('jc')).toBeLessThan(idx('public_key'))
    expect(idx('public_key')).toBeLessThan(idx('endpoint'))
    expect(idx('endpoint')).toBeLessThan(idx('allowed_ip'))
  })

  it('sends obfuscation params, skipping default headers', () => {
    expect(lines).toEqual(expect.arrayContaining(['jc=4', 'jmin=10', 'jmax=50', 's1=60', 's2=100', 'h1=1234567', 'h4=4567890']))
    expect(lines).not.toContain('h2=2')
    expect(lines).not.toContain('h3=3')
  })

  it('uses the resolved IP, keepalive and every allowed ip', () => {
    expect(lines).toContain('endpoint=203.0.113.7:51820')
    expect(lines).toContain('persistent_keepalive_interval=25')
    expect(lines).toContain('replace_allowed_ips=true')
    expect(lines.filter((l) => l.startsWith('allowed_ip='))).toEqual(['allowed_ip=0.0.0.0/0', 'allowed_ip=::/0'])
  })

  it('brackets IPv6 endpoints and omits absent optional fields', () => {
    const v6 = buildUapiSet({ ...tunnel, keepalive: undefined }, { privateKey: KEY(1) }, '2001:db8::1')
    expect(v6).toContain('endpoint=[2001:db8::1]:51820')
    expect(v6).not.toContain('preshared_key')
    expect(v6).not.toContain('persistent_keepalive_interval')
  })

  it('passes newer obfuscation keys through', () => {
    const t = { ...tunnel, awg: { ...tunnel.awg, extra: { s3: '20', i1: '<b 0xdead>' } } }
    const out = buildUapiSet(t, { privateKey: KEY(1) }, '203.0.113.7')
    expect(out).toContain('s3=20')
    expect(out).toContain('i1=<b 0xdead>')
  })
})

describe('splitEndpoint', () => {
  it.each([
    ['1.2.3.4:51820', '1.2.3.4', '51820'],
    ['host.example:1', 'host.example', '1'],
    ['[::1]:443', '::1', '443']
  ])('%s', (input, host, port) => {
    expect(splitEndpoint(input)).toEqual({ host, port })
  })

  it('rejects a missing port', () => {
    expect(() => splitEndpoint('nohost')).toThrow()
  })
})

describe('parseUapi', () => {
  it('splits device and per-peer fields', () => {
    const { device, peers } = parseUapi(
      ['private_key=aa', 'listen_port=1234', 'public_key=bb', 'tx_bytes=10', 'rx_bytes=20', 'last_handshake_time_sec=99', 'public_key=cc', 'tx_bytes=1', 'errno=0', '', ''].join('\n')
    )
    expect(device).toMatchObject({ listen_port: '1234' })
    expect(peers).toHaveLength(2)
    expect(peers[0]).toMatchObject({ public_key: 'bb', tx_bytes: '10', rx_bytes: '20', last_handshake_time_sec: '99' })
    expect(peers[1].tx_bytes).toBe('1')
  })
})

describe('isHandshakeFresh', () => {
  const now = 1_000_000
  it('is false when there has never been a handshake', () => {
    expect(isHandshakeFresh({ rxBytes: 0, txBytes: 0, lastHandshakeSec: 0 }, now)).toBe(false)
  })
  it('is true within 180s and false after', () => {
    expect(isHandshakeFresh({ rxBytes: 0, txBytes: 0, lastHandshakeSec: now - 179 }, now)).toBe(true)
    expect(isHandshakeFresh({ rxBytes: 0, txBytes: 0, lastHandshakeSec: now - 180 }, now)).toBe(false)
  })
})

describe('empty obfuscation chains', () => {
  it('are not sent (configs saved before import started dropping them)', () => {
    const t = { ...tunnel, awg: { ...tunnel.awg, extra: { i1: '<r 2>', i2: '', i3: '' } } }
    const out = buildUapiSet(t, { privateKey: KEY(1) }, '203.0.113.7')
    expect(out).toContain('i1=<r 2>')
    expect(out).not.toMatch(/^i[23]=/m)
  })
})
