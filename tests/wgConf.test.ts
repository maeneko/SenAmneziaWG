import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AWG_CONF_KEYS, AWG_EXTRA_KEYS, AWG_TOGGLES, detectAwgVersion } from '../src/shared/awgVersion'
import { DEFAULT_MTU, buildWgConf } from '../src/main/config/wgConf'
import { parseIni, parseWgConfig } from '../src/main/config/wgConfig'
import { buildUapiSet } from '../src/main/tunnel/uapiConfig'
import type { Tunnel } from '../src/shared/types'

const KEY_A = Buffer.alloc(32, 1).toString('base64')
const KEY_B = Buffer.alloc(32, 2).toString('base64')
const KEY_C = Buffer.alloc(32, 4).toString('base64')
const PSK = Buffer.alloc(32, 3).toString('base64')

const peer = `
[Peer]
PublicKey = ${KEY_B}
PresharedKey = ${PSK}
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = 203.0.113.7:51820
PersistentKeepalive = 25
`
const head = `[Interface]
PrivateKey = ${KEY_A}
Address = 10.8.1.2/32, fd00::2/128
DNS = 1.1.1.1, 1.0.0.1
`

/** One config per protocol generation; each adds keys on top of the previous one. */
const GENERATIONS: Record<string, string> = {
  wireguard: head + peer,
  legacy: `${head}Jc = 4\nJmin = 10\nJmax = 50\nS1 = 60\nS2 = 100\nH1 = 1234567\nH2 = 2345678\nH3 = 3456789\nH4 = 4567890\nI1 = <b 0xf6ab3267fa><c><b 0xf6ab><t><r 10><wt 10>\n${peer}`,
  '2.0': `${head}Jc = 4\nJmin = 10\nJmax = 50\nS1 = 60\nS2 = 100\nS3 = 20\nS4 = 30\nH1 = 100-200\nH2 = 300-400\nH3 = 500-600\nH4 = 700-800\n${peer}`,
  '3.0': `${head}Jc = 4\nJmin = 10\nJmax = 50\nS1 = 60\nS2 = 100\nH1 = 1234567\nH2 = 2345678\nH3 = 3456789\nH4 = 4567890\nHeaderProtectionKey = ${KEY_C}\nContentPaddingAddition = 0-64\nRekeyAfterTime = 110-130\nRekeyTimeout = 5-8\nRejectAfterTime = 170-190\nKeepaliveTimeout = 8-12\nMaxHandshakeAttempts = 5\n${peer}`,
  '3.1': `${head}Jc = 4\nJmin = 10\nJmax = 50\nS1 = 60\nS2 = 100\nH1 = 1234567\nH2 = 2345678\nH3 = 3456789\nH4 = 4567890\nRandomTrailers = on\nDisableCookies = off\n${peer}`
}

const parse = (ini: string, over: { mtu?: number } = {}) => parseWgConfig(ini, { name: 'Германия', ...over })

describe('buildWgConf round trip', () => {
  it.each(Object.entries(GENERATIONS))('%s survives parse → build → parse', (_name, ini) => {
    const first = parse(ini)
    const second = parse(buildWgConf(first.tunnel, first.secrets))

    // A toggle that is off is the daemon's default and is left out, exactly as buildUapiSet leaves it out.
    const expectedExtra = Object.fromEntries(
      Object.entries(first.tunnel.awg.extra).filter(([k, v]) => !(AWG_TOGGLES.includes(k) && v === 'off'))
    )
    expect(second.tunnel.awg).toEqual({ ...first.tunnel.awg, extra: expectedExtra })
    expect(second.tunnel).toMatchObject({
      endpoint: first.tunnel.endpoint,
      address: first.tunnel.address,
      dns: first.tunnel.dns,
      allowedIps: first.tunnel.allowedIps,
      peerPublicKey: first.tunnel.peerPublicKey,
      keepalive: first.tunnel.keepalive
    })
    expect(second.secrets).toEqual(first.secrets)
    expect(detectAwgVersion(second.tunnel.awg)).toBe(detectAwgVersion(first.tunnel.awg))
  })
})

describe('buildWgConf output', () => {
  const tunnel = (): Tunnel => parse(GENERATIONS['3.1']).tunnel
  const secrets = { privateKey: KEY_A, presharedKey: PSK }

  it('keeps the endpoint as written instead of resolving it', () => {
    expect(buildWgConf({ ...tunnel(), endpoint: 'vpn.example.org:51820' }, secrets)).toContain('Endpoint = vpn.example.org:51820')
  })

  it('uses the same default MTU as the macOS backend when the key has none', () => {
    expect(buildWgConf({ ...tunnel(), mtu: undefined }, secrets)).toContain(`MTU = ${DEFAULT_MTU}`)
    expect(buildWgConf({ ...tunnel(), mtu: 1380 }, secrets)).toContain('MTU = 1380')
  })

  it('writes the DNS it is given, and no DNS line when there is none', () => {
    expect(buildWgConf(tunnel(), secrets, ['9.9.9.9'])).toContain('DNS = 9.9.9.9')
    expect(buildWgConf(tunnel(), secrets, [])).not.toMatch(/^DNS/m)
  })

  it('leaves out zero numbers, default headers and empty values', () => {
    const t = parse(GENERATIONS.wireguard).tunnel
    const text = buildWgConf({ ...t, awg: { ...t.awg, extra: { i2: '' } } }, secrets)
    expect(text).not.toMatch(/^(Jc|Jmin|Jmax|S1|S2|H1|H2|H3|H4|I2)\b/m)
  })

  it('writes an enabled 3.1 toggle as on and omits a disabled one', () => {
    const text = buildWgConf(tunnel(), secrets)
    expect(text).toMatch(/^RandomTrailers = on$/m)
    expect(text).not.toMatch(/DisableCookies/)
  })

  it('never writes anything that runs commands', () => {
    const text = buildWgConf(tunnel(), secrets)
    expect(text).not.toMatch(/PreUp|PostUp|PreDown|PostDown|^Table/im)
  })

  it('produces a file the project parser reads back section by section', () => {
    const ini = parseIni(buildWgConf(tunnel(), secrets))
    expect(Object.keys(ini)).toEqual(['interface', 'peer'])
    expect(ini.peer[0].presharedkey).toBe(PSK)
  })
})

describe('buildWgConf refuses what would change the file', () => {
  const t = parse(GENERATIONS.wireguard).tunnel
  const secrets = { privateKey: KEY_A }

  it.each([
    ['a line break (would smuggle in another key)', { ...t, endpoint: '1.2.3.4:5\nPostUp = calc' }],
    ['a carriage return in the middle of a value', { ...t, address: '10.0.0.2/32\rPostUp = calc' }],
    ['a # (the reader cuts the line there)', { ...t, endpoint: '1.2.3.4:5#x' }]
  ])('rejects %s', (_name, bad) => {
    expect(() => buildWgConf(bad as Tunnel, secrets)).toThrow(/недопустимые символы/)
  })

  it('rejects an AWG key the Windows parser would not accept', () => {
    expect(() => buildWgConf({ ...t, awg: { ...t.awg, extra: { future_key: '1' } } }, secrets)).toThrow(/не поддерживается/)
  })
})

describe('AWG_CONF_KEYS', () => {
  it('is the exact inverse of AWG_EXTRA_KEYS', () => {
    for (const [confKey, uapiKey] of Object.entries(AWG_EXTRA_KEYS)) {
      expect(AWG_CONF_KEYS[uapiKey]?.toLowerCase()).toBe(confKey)
    }
    expect(Object.keys(AWG_CONF_KEYS)).toHaveLength(Object.keys(AWG_EXTRA_KEYS).length)
  })
})

/**
 * Files shared with the Go tests of the Windows helper (helper/). Regenerate with
 *   UPDATE_FIXTURES=1 npx vitest run tests/wgConf.test.ts
 *
 * <generation>.conf  what buildWgConf writes; the helper's validator and the tunnel service's own
 *                    reader must both accept it.
 * <generation>.uapi  what the macOS path sends the daemon for the same tunnel; on Windows the tunnel
 *                    service derives the daemon's settings from the .conf itself, and a Go test checks
 *                    that both routes configure the daemon identically.
 */
describe('fixtures shared with the helper tests', () => {
  const dir = resolve('helper/internal/proto/testdata')
  const check = (file: string, text: string): void => {
    if (process.env['UPDATE_FIXTURES']) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, file), text)
    }
    expect(readFileSync(join(dir, file), 'utf8')).toBe(text)
  }

  it.each(Object.entries(GENERATIONS))('%s .conf matches the committed file', (name, ini) => {
    const { tunnel, secrets } = parse(ini)
    check(`${name}.conf`, buildWgConf(tunnel, secrets))
  })

  it.each(Object.entries(GENERATIONS))('%s UAPI body matches the committed file', (name, ini) => {
    const { tunnel, secrets } = parse(ini)
    check(`${name}.uapi`, buildUapiSet(tunnel, secrets, '203.0.113.7'))
  })
})
