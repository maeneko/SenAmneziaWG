import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { generateAuthKey, privateKeyFromSeed, publicKeyFromRaw, requestSigString, spkiPinOfCert } from '../src/main/config/senLink'
import { SenError, type SenServer, senRequest } from '../src/main/sen/client'

const fixture = (name: string): Buffer => readFileSync(join(__dirname, 'fixtures', name))
const tlsMaterial = { key: fixture('sen-tls.key'), cert: fixture('sen-tls.crt') }
const certPin = spkiPinOfCert(new crypto.X509Certificate(tlsMaterial.cert))

// The server's signing key is a fixed seed; the device's is generated per test.
const serverKey = privateKeyFromSeed(Buffer.alloc(32, 9))
const serverPub = (crypto.createPublicKey(serverKey).export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32)

interface Seen {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: Buffer
}

let closers: Array<() => void> = []
afterEach(() => {
  closers.forEach((c) => c())
  closers = []
})

/** A stand-in for forgetting's /sub/v1 listener: replies with a signed envelope of whatever `reply` returns. */
async function listen(
  opts: { tls?: boolean; reply?: (seen: Seen) => { status: number; payload: unknown }; tamper?: boolean } = {}
): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = []
  const handler: http.RequestListener = (req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const s: Seen = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) }
      seen.push(s)
      const { status, payload } = opts.reply?.(s) ?? { status: 200, payload: { ok: true } }
      const body = JSON.stringify(payload)
      const sig = crypto.sign(null, Buffer.from(body), serverKey).toString('base64url')
      res.statusCode = status
      res.end(JSON.stringify({ body: opts.tamper ? body.replace('true', 'fals') : body, sig }))
    })
  }
  const server = opts.tls ? https.createServer(tlsMaterial, handler) : http.createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  closers.push(() => server.close())
  return { port: (server.address() as AddressInfo).port, seen }
}

const device = generateAuthKey()
const deviceKey = privateKeyFromSeed(device.seed)
const sign = async (m: string): Promise<Buffer> => crypto.sign(null, Buffer.from(m), deviceKey)
let clock = 1_700_000_000
const nextTs = (): number => ++clock

const serverAt = (port: number, extra: Partial<SenServer> = {}): SenServer => ({
  addrs: [{ host: '127.0.0.1', port }],
  tls: false,
  signPub: serverPub,
  ...extra
})

describe('senRequest', () => {
  it('signs the request the way the server verifies it and returns the verified body', async () => {
    const { port, seen } = await listen({ reply: () => ({ status: 201, payload: { device: 5 } }) })
    const body = { pub_key: 'x' }
    const res = await senRequest(serverAt(port), {
      method: 'POST',
      path: '/sub/v1/rekey',
      body,
      sign,
      device: 5,
      nextTs,
      version: '0.6.5'
    })
    expect(res).toEqual({ status: 201, data: { device: 5 } })

    const [s] = seen
    expect(s.headers['x-sen-device']).toBe('5')
    expect(s.headers['x-sen-version']).toBe('0.6.5')
    expect(s.body.toString()).toBe(JSON.stringify(body))
    const ts = Number(s.headers['x-sen-ts'])
    const ok = crypto.verify(
      null,
      Buffer.from(requestSigString('POST', '/sub/v1/rekey', ts, s.body)),
      publicKeyFromRaw(device.pub),
      Buffer.from(String(s.headers['x-sen-sig']), 'base64url')
    )
    expect(ok).toBe(true)
  })

  it('sends a strictly increasing ts, so two identical requests never repeat a signature', async () => {
    const { port, seen } = await listen()
    const req = { method: 'GET', path: '/sub/v1/config', sign, nextTs, version: '1' } as const
    await senRequest(serverAt(port), req)
    await senRequest(serverAt(port), req)
    expect(Number(seen[1].headers['x-sen-ts'])).toBeGreaterThan(Number(seen[0].headers['x-sen-ts']))
    expect(seen[1].headers['x-sen-sig']).not.toBe(seen[0].headers['x-sen-sig'])
  })

  it('omits X-Sen-Device when registering', async () => {
    const { port, seen } = await listen()
    await senRequest(serverAt(port), { method: 'POST', path: '/sub/v1/register', body: {}, sign, nextTs, version: '1' })
    expect(seen[0].headers['x-sen-device']).toBeUndefined()
  })

  it('refuses a response whose signature does not verify', async () => {
    const { port } = await listen({ tamper: true })
    await expect(
      senRequest(serverAt(port), { method: 'GET', path: '/sub/v1/config', sign, nextTs, version: '1' })
    ).rejects.toMatchObject({ code: 'bad_signature' })
  })

  it('refuses a response signed by someone else', async () => {
    const { port } = await listen()
    await expect(
      senRequest(serverAt(port, { signPub: Buffer.alloc(32, 1) }), { method: 'GET', path: '/x', sign, nextTs, version: '1' })
    ).rejects.toMatchObject({ code: 'bad_signature' })
  })

  it.each([
    [403, 'device_limit', 'device_limit'],
    [404, 'not_found', 'not_found'],
    [401, 'unauthorized', 'unauthorized'],
    [429, 'rate_limited', 'rate_limited'],
    [502, 'unavailable', 'unavailable']
  ])('turns HTTP %i {error:%s} into SenError %s', async (status, error, code) => {
    const { port } = await listen({ reply: () => ({ status, payload: { error } }) })
    const err = await senRequest(serverAt(port), { method: 'GET', path: '/x', sign, nextTs, version: '1' }).catch((e) => e)
    expect(err).toBeInstanceOf(SenError)
    expect(err.code).toBe(code)
  })

  it('moves on to the next address only when there is no answer, not on a refusal', async () => {
    const dead = await listen()
    closers.pop()!() // the first address is closed
    const live = await listen({ reply: () => ({ status: 200, payload: { from: 'live' } }) })
    const server: SenServer = {
      ...serverAt(live.port),
      addrs: [
        { host: '127.0.0.1', port: dead.port },
        { host: '127.0.0.1', port: live.port }
      ]
    }
    const res = await senRequest(server, { method: 'GET', path: '/x', sign, nextTs, version: '1' })
    expect(res.data).toEqual({ from: 'live' })

    const refusing = await listen({ reply: () => ({ status: 404, payload: { error: 'not_found' } }) })
    const second = await listen()
    const err = await senRequest(
      { ...server, addrs: [{ host: '127.0.0.1', port: refusing.port }, { host: '127.0.0.1', port: second.port }] },
      { method: 'GET', path: '/x', sign, nextTs, version: '1' }
    ).catch((e) => e)
    expect(err.code).toBe('not_found')
    expect(second.seen).toHaveLength(0)
  })

  it('reports a dead server as a network error', async () => {
    const { port } = await listen()
    closers.pop()!()
    await expect(
      senRequest(serverAt(port), { method: 'GET', path: '/x', sign, nextTs, version: '1' })
    ).rejects.toMatchObject({ code: 'network' })
  })

  describe('TLS with a pinned certificate', () => {
    it('connects when the pin matches, with no CA and no host name involved', async () => {
      const { port } = await listen({ tls: true })
      const res = await senRequest(serverAt(port, { tls: true, tlsPin: certPin }), {
        method: 'GET',
        path: '/x',
        sign,
        nextTs,
        version: '1'
      })
      expect(res.data).toEqual({ ok: true })
    })

    it('sends nothing when the pin does not match', async () => {
      const { port, seen } = await listen({ tls: true })
      await expect(
        senRequest(serverAt(port, { tls: true, tlsPin: Buffer.alloc(32, 1) }), {
          method: 'POST',
          path: '/sub/v1/register',
          body: { sub: 'the-secret' },
          sign,
          nextTs,
          version: '1'
        })
      ).rejects.toMatchObject({ code: 'pin_mismatch' })
      expect(seen).toHaveLength(0)
    })
  })
})
