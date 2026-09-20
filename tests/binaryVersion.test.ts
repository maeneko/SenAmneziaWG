import { describe, expect, it } from 'vitest'
import { binarySupports, parseBinaryVersion } from '../src/main/tunnel/binaryVersion'
import { buildUapiSet } from '../src/main/tunnel/uapiConfig'
import { parseWgConfig } from '../src/main/config/wgConfig'

describe('parseBinaryVersion', () => {
  it('reads the old 0.0.date scheme', () => {
    expect(parseBinaryVersion('amneziawg-go 0.0.20250522\n\nUserspace AmneziaWG daemon')).toEqual({ major: 0, minor: 0, raw: '0.0.20250522' })
  })
  it('reads the v3 scheme', () => {
    expect(parseBinaryVersion('amneziawg-go v3.1.20260828')).toEqual({ major: 3, minor: 1, raw: '3.1.20260828' })
  })
  it('returns null for garbage', () => expect(parseBinaryVersion('command not found')).toBeNull())
})

describe('binarySupports', () => {
  const old = { major: 0, minor: 0 }
  const v30 = { major: 3, minor: 0 }
  const v31 = { major: 3, minor: 1 }
  it('old daemon runs legacy and 2.0 only', () => {
    expect(binarySupports(old, 'legacy')).toBe(true)
    expect(binarySupports(old, '2.0')).toBe(true)
    expect(binarySupports(old, '3.0')).toBe(false)
    expect(binarySupports(old, '3.1')).toBe(false)
  })
  it('3.0 daemon cannot run 3.1 configs', () => {
    expect(binarySupports(v30, '3.0')).toBe(true)
    expect(binarySupports(v30, '3.1')).toBe(false)
  })
  it('3.1 daemon runs everything', () => {
    for (const v of ['wireguard', 'legacy', '2.0', '3.0', '3.1'] as const) expect(binarySupports(v31, v)).toBe(true)
  })
})

describe('HeaderProtectionKey', () => {
  const key = (n: number): string => Buffer.alloc(32, n).toString('base64')
  const ini = (hpk: string): string =>
    `[Interface]\nAddress = 10.8.1.2/32\nPrivateKey = ${key(1)}\nHeaderProtectionKey = ${hpk}\n\n[Peer]\nPublicKey = ${key(2)}\nEndpoint = 203.0.113.7:51820\n`

  it('goes to UAPI as hex (amneziawg-go HeaderCipherKey.FromHex)', () => {
    const { tunnel, secrets } = parseWgConfig(ini(key(9)), { name: 'x' })
    const body = buildUapiSet(tunnel, secrets, '203.0.113.7')
    expect(body).toContain(`header_protection_key=${Buffer.alloc(32, 9).toString('hex')}`)
    expect(body).not.toContain(key(9))
  })

  it('is rejected at import when malformed', () => {
    expect(() => parseWgConfig(ini('not-a-key'), { name: 'x' })).toThrow(/HeaderProtectionKey/)
  })
})
