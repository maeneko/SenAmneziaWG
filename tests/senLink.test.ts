import crypto from 'node:crypto'
import { crc32 } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  SenLinkError,
  decodeSenLink,
  generateAuthKey,
  generateWgKeyPair,
  isSenLink,
  privateKeyFromSeed,
  requestSigString,
  verifyResponse
} from '../src/main/config/senLink'

// Vectors made by the server's own codec (forgetting/awg-ui/sen.ts), so a drift between the two shows up here.
const SIGN_PUB = 'fd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f618'
const PLAIN =
  'sen://AQABBMsAcQecuwcHBwcHBwcHBwcHBwcHBwf9FyQ4WqDHW2T7eM1gL6HZkf3r92sTxY7XAurINen2GArQodC10LzRjNGPMVDMpw'
const TLS =
  'sen://AQEDBMsAcQecuwYgAQ24AAAAAAAAAAAAAAABAbtED3Zwbi5leGFtcGxlLmNvbSD7BwcHBwcHBwcHBwcHBwcHB_0XJDhaoMdbZPt4zWAvodmR_ev3axPFjtcC6sg16fYYBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUAd-AhzQ'
const RESPONSE = {
  body: '{"config":{"rev":"abc"}}',
  sig: 'HxIg9KFA7FL68F0vlCiswgZ0nBn2k4QjnMzyMnMS7hPq8-4Hv6Jb5FyhF1zg-3qJzOo2JUcF3TSC2soa8FLzAw'
}
const REQ_SIG =
  'e7SRRBNFrfcJovCNq0M2OpelKyF0tXXvOzYSt5A9CwpDETbJrF3GgLMnVE_FcH4sj4avLCkG3C5_gCnczbLaAA'

describe('sen:// link', () => {
  it('decodes a plain link', () => {
    const l = decodeSenLink(PLAIN)
    expect(l.tls).toBe(false)
    expect(l.addrs).toEqual([{ host: '203.0.113.7', port: 40123 }])
    expect(l.secret).toEqual(Buffer.alloc(16, 7))
    expect(l.signPub.toString('hex')).toBe(SIGN_PUB)
    expect(l.tlsPin).toBeUndefined()
    expect(l.name).toBe('Семья')
  })

  it('decodes TLS, IPv6, a domain and an empty name', () => {
    const l = decodeSenLink(TLS)
    expect(l.tls).toBe(true)
    expect(l.addrs).toEqual([
      { host: '203.0.113.7', port: 40123 },
      { host: '2001:db8::1', port: 443 },
      { host: 'vpn.example.com', port: 8443 }
    ])
    expect(l.tlsPin).toEqual(Buffer.alloc(32, 5))
    expect(l.name).toBe('')
  })

  it('tolerates whitespace and an upper-case scheme, as pasted from a chat', () => {
    const spaced = 'SEN://' + PLAIN.slice(6, 30) + ' \n' + PLAIN.slice(30)
    expect(decodeSenLink(`  ${spaced}  `).name).toBe('Семья')
    expect(isSenLink(' SEN://x')).toBe(true)
    expect(isSenLink('vpn://x')).toBe(false)
  })

  it('rejects a damaged link', () => {
    expect(() => decodeSenLink('vpn://abc')).toThrow(SenLinkError)
    expect(() => decodeSenLink('sen://a')).toThrow(/короткая/)
    expect(() => decodeSenLink('sen://!!!')).toThrow(/символы/)
    const flipped = PLAIN.slice(0, 20) + (PLAIN[20] === 'A' ? 'B' : 'A') + PLAIN.slice(21)
    expect(() => decodeSenLink(flipped)).toThrow(/контрольная сумма/)
  })

  it('rejects a link with an unknown version, flag or trailing bytes even when the CRC is right', () => {
    const reseal = (mutate: (body: Buffer) => Buffer): string => {
      const raw = Buffer.from(PLAIN.slice(6), 'base64url')
      const body = mutate(Buffer.from(raw.subarray(0, raw.length - 4)))
      const crc = Buffer.alloc(4)
      crc.writeUInt32BE(crc32(body))
      return 'sen://' + Buffer.concat([body, crc]).toString('base64url')
    }
    expect(() => decodeSenLink(reseal((b) => ((b[0] = 2), b)))).toThrow(/версия/)
    expect(() => decodeSenLink(reseal((b) => ((b[1] = 0x80), b)))).toThrow(/флаги/)
    expect(() => decodeSenLink(reseal((b) => Buffer.concat([b, Buffer.from([0])])))).toThrow(/Лишние/)
  })
})

describe('sen:// signatures', () => {
  const signPub = Buffer.from(SIGN_PUB, 'hex')

  it('accepts the server response and refuses a changed body or signature', () => {
    expect(verifyResponse(RESPONSE, signPub)).toBe(true)
    expect(verifyResponse({ ...RESPONSE, body: RESPONSE.body.replace('abc', 'abd') }, signPub)).toBe(false)
    expect(verifyResponse({ ...RESPONSE, sig: RESPONSE.sig.slice(0, -2) + 'AA' }, signPub)).toBe(false)
    expect(verifyResponse({ body: 1, sig: 2 }, signPub)).toBe(false)
    expect(verifyResponse(RESPONSE, Buffer.alloc(32, 1))).toBe(false)
  })

  it('signs a request exactly as the server verifies it', () => {
    const key = privateKeyFromSeed(Buffer.alloc(32, 3))
    const str = requestSigString('get', '/sub/v1/config', 1700000000, '')
    expect(str).toBe(
      'GET\n/sub/v1/config\n1700000000\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    )
    expect(crypto.sign(null, Buffer.from(str), key).toString('base64url')).toBe(REQ_SIG)
  })
})

describe('key generation', () => {
  it('makes a 32-byte WireGuard pair whose public half matches the private one', () => {
    const { privateKey, publicKey } = generateWgKeyPair()
    expect(Buffer.from(privateKey, 'base64')).toHaveLength(32)
    expect(Buffer.from(publicKey, 'base64')).toHaveLength(32)
    const der = Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(privateKey, 'base64')])
    const pub = crypto.createPublicKey(crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }))
    expect((pub.export({ format: 'jwk' }).x as string)).toBe(Buffer.from(publicKey, 'base64').toString('base64url'))
  })

  it('makes an Ed25519 pair that signs and verifies', () => {
    const { seed, pub } = generateAuthKey()
    expect(seed).toHaveLength(32)
    expect(pub).toHaveLength(32)
    const sig = crypto.sign(null, Buffer.from('x'), privateKeyFromSeed(seed))
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub])
    expect(crypto.verify(null, Buffer.from('x'), crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' }), sig)).toBe(true)
  })
})
