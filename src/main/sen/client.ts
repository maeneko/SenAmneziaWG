import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { type SenAddr, requestSigString, spkiPinOfCert, verifyResponse } from '../config/senLink'

/** What the server refused with (its own error codes) or why the exchange did not happen at all. */
export type SenErrorCode =
  | 'network'
  | 'bad_response'
  | 'bad_signature'
  | 'pin_mismatch'
  | 'bad_request'
  | 'unauthorized'
  | 'device_limit'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'unavailable'

const MESSAGES: Record<SenErrorCode, string> = {
  network: 'Сервер подписки недоступен',
  bad_response: 'Сервер подписки ответил не так, как ожидалось',
  bad_signature: 'Ответ сервера не прошёл проверку подписи — ссылка выдана другим сервером или ответ подменён',
  pin_mismatch: 'Сертификат сервера не совпадает с тем, что записан в ключе',
  bad_request: 'Сервер отклонил запрос',
  unauthorized: 'Сервер не узнал это устройство',
  device_limit: 'Достигнут лимит устройств для этого мастер-ключа',
  not_found: 'Мастер-ключ не найден или отозван',
  conflict: 'Ключи устройства уже заняты, попробуйте ещё раз',
  rate_limited: 'Слишком много запросов, попробуйте позже',
  unavailable: 'Сервер сейчас не может ответить, попробуйте позже'
}

export class SenError extends Error {
  constructor(
    readonly code: SenErrorCode,
    detail?: string
  ) {
    super(detail ? `${MESSAGES[code]} (${detail})` : MESSAGES[code])
  }
}

/** Where and how to talk to one server: everything comes from the link, then from the last config. */
export interface SenServer {
  addrs: SenAddr[]
  tls: boolean
  tlsPin?: Buffer
  signPub: Buffer
}

export interface SenRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  body?: unknown
  /** Signs the request string with the device's auth key (locally, or in the Linux service). Absent: unsigned. */
  sign?: (message: string) => Promise<Buffer | string>
  /** Value of X-Sen-Device; absent for register, whose signature proves the key in its own body. */
  device?: number
  /** Strictly increasing unix seconds; the caller keeps it durable (a replayed signature is refused). */
  nextTs?: () => number
  /** Per address; the default is for a request that matters, a preview wants an answer quickly or none. */
  timeoutMs?: number
  version: string
}

export interface SenResponse {
  status: number
  data: Record<string, unknown>
}

const TIMEOUT_MS = 10_000
const MAX_BODY = 1 << 20

const ERROR_CODES: Record<string, SenErrorCode> = {
  bad_request: 'bad_request',
  unauthorized: 'unauthorized',
  device_limit: 'device_limit',
  not_found: 'not_found',
  conflict: 'conflict',
  rate_limited: 'rate_limited',
  unavailable: 'unavailable'
}

/**
 * The TLS socket is connected and checked here rather than by https.request: the certificate is
 * self-signed, so no CA and no host name are involved — only its SPKI hash from the link — and the
 * request (which carries the link's secret when registering) must not leave before that check.
 */
function connectTls(server: SenServer, addr: SenAddr, timeoutMs: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: addr.host,
      port: addr.port,
      rejectUnauthorized: false,
      servername: net.isIP(addr.host) ? undefined : addr.host,
      timeout: timeoutMs
    })
    const fail = (err: Error): void => {
      socket.destroy()
      reject(err instanceof SenError ? err : new SenError('network', err.message))
    }
    socket.once('error', fail)
    socket.once('timeout', () => fail(new Error('таймаут')))
    socket.once('secureConnect', () => {
      const raw = socket.getPeerCertificate().raw
      const pin = raw ? spkiPinOfCert(new crypto.X509Certificate(raw)) : null
      if (!pin || !server.tlsPin || !crypto.timingSafeEqual(pin, server.tlsPin)) return fail(new SenError('pin_mismatch'))
      socket.removeListener('error', fail)
      socket.setTimeout(0)
      resolve(socket)
    })
  })
}

async function exchange(server: SenServer, addr: SenAddr, req: SenRequest, payload: Buffer): Promise<{ status: number; text: string }> {
  const socket = server.tls ? await connectTls(server, addr, req.timeoutMs ?? TIMEOUT_MS) : null
  const headers: Record<string, string | number> = { 'X-Sen-Version': req.version, 'Content-Length': payload.length }
  // A request made before there is a device (peek) is not signed: the link's secret in its body is the credential.
  if (req.sign && req.nextTs) {
    const ts = req.nextTs()
    const sig = Buffer.from(await req.sign(requestSigString(req.method, req.path, ts, payload)))
    headers['X-Sen-Ts'] = ts
    headers['X-Sen-Sig'] = sig.toString('base64url')
  }
  if (req.device !== undefined) headers['X-Sen-Device'] = req.device
  if (payload.length) headers['Content-Type'] = 'application/json'

  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: addr.host,
        port: addr.port,
        method: req.method,
        path: req.path,
        headers,
        timeout: req.timeoutMs ?? TIMEOUT_MS,
        // With agent:false Node ignores createConnection and would open a plain TCP connection.
        ...(socket ? { createConnection: () => socket } : { agent: false })
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > MAX_BODY) r.destroy(new Error('ответ слишком большой'))
          else chunks.push(c)
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', reject)
      }
    )
    r.on('timeout', () => r.destroy(new Error('таймаут')))
    r.on('error', (err) => reject(new SenError('network', err.message)))
    r.end(payload)
  })
}

/**
 * One signed exchange with the server. The addresses are tried in order, and only a failure to get an
 * answer moves on to the next: an answer, even a refusal, is the server speaking. The answer must carry
 * the server's signature — over plain HTTP that is the only thing standing between the config and a MITM.
 */
export async function senRequest(server: SenServer, req: SenRequest): Promise<SenResponse> {
  const payload = req.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(req.body), 'utf8')
  let last: SenError = new SenError('network')
  for (const addr of server.addrs) {
    let raw: { status: number; text: string }
    try {
      raw = await exchange(server, addr, req, payload)
    } catch (err) {
      last = err instanceof SenError ? err : new SenError('network', err instanceof Error ? err.message : String(err))
      continue
    }
    let envelope: { body?: unknown; sig?: unknown }
    try {
      envelope = JSON.parse(raw.text)
    } catch {
      last = new SenError('bad_response', `HTTP ${raw.status}`)
      continue
    }
    if (!verifyResponse({ body: envelope.body, sig: envelope.sig }, server.signPub)) {
      last = new SenError('bad_signature')
      continue
    }
    let data: Record<string, unknown>
    try {
      data = JSON.parse(envelope.body as string)
    } catch {
      throw new SenError('bad_response')
    }
    if (raw.status >= 200 && raw.status < 300) return { status: raw.status, data }
    const code = typeof data.error === 'string' ? ERROR_CODES[data.error] : undefined
    throw new SenError(code ?? 'unavailable', code ? undefined : `HTTP ${raw.status}`)
  }
  throw last
}
