import crypto from 'node:crypto'
import { crc32 } from 'node:zlib'

/**
 * sen:// — subscription link (master key) and the signatures of the /sub/v1 protocol.
 * Byte layout and signing scheme: forgetting/docs/sen-link.md; the server side is forgetting/awg-ui/sen.ts,
 * so a change here is a change of the protocol.
 */

export const SEN_PREFIX = 'sen://'
const SEN_VERSION = 1
const FLAG_TLS = 0x01
const ADDR_V4 = 0x04
const ADDR_V6 = 0x06
const ADDR_DOMAIN = 0x44

export class SenLinkError extends Error {}

export interface SenAddr {
  host: string
  port: number
}

export interface SenLink {
  tls: boolean
  addrs: SenAddr[]
  /** 16 bytes; only needed to register a device. */
  secret: Buffer
  /** 32 bytes, Ed25519: signs every response of the server. */
  signPub: Buffer
  /** 32 bytes, SHA-256 of the server certificate's SPKI; only with tls. */
  tlsPin?: Buffer
  name: string
}

export const isSenLink = (text: string): boolean => text.trim().toLowerCase().startsWith(SEN_PREFIX)

function bytesToIpv6(b: Buffer): string {
  const g: string[] = []
  for (let i = 0; i < 16; i += 2) g.push(b.readUInt16BE(i).toString(16))
  // The longest run of zeros folds into «::», as in the usual text form.
  let bestStart = -1
  let bestLen = 0
  for (let i = 0; i < 8; ) {
    if (g[i] !== '0') {
      i++
      continue
    }
    let j = i
    while (j < 8 && g[j] === '0') j++
    if (j - i > bestLen) {
      bestStart = i
      bestLen = j - i
    }
    i = j
  }
  if (bestLen < 2) return g.join(':')
  return g.slice(0, bestStart).join(':') + '::' + g.slice(bestStart + bestLen).join(':')
}

export function decodeSenLink(link: string): SenLink {
  const t = link.trim()
  if (!isSenLink(t)) throw new SenLinkError('Ссылка должна начинаться с sen://')
  const payload = t.slice(SEN_PREFIX.length).replace(/\s+/g, '')
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) throw new SenLinkError('Ссылка повреждена: недопустимые символы')
  const raw = Buffer.from(payload, 'base64url')
  if (raw.length < 3 + 4) throw new SenLinkError('Ссылка слишком короткая')

  const body = raw.subarray(0, raw.length - 4)
  if (raw.readUInt32BE(raw.length - 4) !== crc32(body)) {
    throw new SenLinkError('Ссылка повреждена: не сошлась контрольная сумма')
  }

  let off = 0
  const take = (n: number): Buffer => {
    if (off + n > body.length) throw new SenLinkError('Ссылка обрезана')
    const s = body.subarray(off, off + n)
    off += n
    return s
  }

  const version = take(1)[0]
  if (version !== SEN_VERSION) throw new SenLinkError(`Неизвестная версия ссылки: ${version}. Обновите SenAWG`)
  const flags = take(1)[0]
  if (flags & ~FLAG_TLS) throw new SenLinkError('Неизвестные флаги ссылки. Обновите SenAWG')
  const n = take(1)[0]
  if (n < 1 || n > 3) throw new SenLinkError('Неверное число адресов')

  const addrs: SenAddr[] = []
  for (let i = 0; i < n; i++) {
    const type = take(1)[0]
    let host: string
    if (type === ADDR_V4) host = [...take(4)].join('.')
    else if (type === ADDR_V6) host = bytesToIpv6(take(16))
    else if (type === ADDR_DOMAIN) {
      const len = take(1)[0]
      if (len < 1) throw new SenLinkError('Пустой домен')
      host = take(len).toString('utf8')
      if (!/^[A-Za-z0-9.-]+$/.test(host)) throw new SenLinkError('Неверный домен')
    } else throw new SenLinkError(`Неизвестный тип адреса: ${type}`)
    const port = take(2).readUInt16BE(0)
    if (port === 0) throw new SenLinkError('Порт 0')
    addrs.push({ host, port })
  }

  const secret = Buffer.from(take(16))
  const signPub = Buffer.from(take(32))
  const tls = (flags & FLAG_TLS) !== 0
  const tlsPin = tls ? Buffer.from(take(32)) : undefined
  const nameLen = take(1)[0]
  if (nameLen > 64) throw new SenLinkError('Имя длиннее 64 байт')
  const name = take(nameLen).toString('utf8')
  if (off !== body.length) throw new SenLinkError('Лишние данные в конце ссылки')

  return { tls, addrs, secret, signPub, tlsPin, name }
}

/** «host:port» for a URL/log; IPv6 goes in brackets. */
export const addrString = ({ host, port }: SenAddr): string => (host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`)

// ── Ed25519 keys as raw 32 bytes ───────────────────────────────────────────
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

export function publicKeyFromRaw(raw: Buffer): crypto.KeyObject {
  if (raw.length !== 32) throw new SenLinkError('Публичный ключ Ed25519: 32 байта')
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' })
}

export function privateKeyFromSeed(seed: Buffer): crypto.KeyObject {
  if (seed.length !== 32) throw new SenLinkError('Ed25519: seed из 32 байт')
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' })
}

/** New Ed25519 pair: the 32-byte seed to keep and the 32-byte public key to send. */
export function generateAuthKey(): { seed: Buffer; pub: Buffer } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  const seed = (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).subarray(-32)
  const pub = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32)
  return { seed, pub }
}

/** New WireGuard (X25519) pair, both halves in base64 as in a .conf. */
export function generateWgKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519')
  const raw = (k: crypto.KeyObject, part: 'd' | 'x'): string =>
    Buffer.from(k.export({ format: 'jwk' })[part] as string, 'base64url').toString('base64')
  return { privateKey: raw(privateKey, 'd'), publicKey: raw(publicKey, 'x') }
}

/** SHA-256 of the SPKI DER of a certificate in DER form — what the link carries as the pin. */
export const spkiPinOfCert = (cert: crypto.X509Certificate): Buffer =>
  crypto.createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest()

// ── Signatures of the protocol ─────────────────────────────────────────────

/** A response is {"body": "<JSON string>", "sig": "<base64url>"}; sig is Ed25519 over the UTF-8 bytes of body. */
export function verifyResponse(res: { body: unknown; sig: unknown }, signPub: Buffer): boolean {
  if (typeof res.body !== 'string' || typeof res.sig !== 'string') return false
  try {
    return crypto.verify(null, Buffer.from(res.body, 'utf8'), publicKeyFromRaw(signPub), Buffer.from(res.sig, 'base64url'))
  } catch {
    return false
  }
}

/** METHOD \n /path \n ts \n hex(sha256(body)); the path has no query, an empty body hashes as the empty string. */
export function requestSigString(method: string, urlPath: string, ts: number, body: Buffer | string): string {
  const h = crypto.createHash('sha256').update(body).digest('hex')
  return `${method.toUpperCase()}\n${urlPath}\n${ts}\n${h}`
}
