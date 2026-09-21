import { connect } from 'node:net'
import { HelperError, PROTOCOL, type HelperRequest, type HelperResponse } from './protocol'
import { startAccepted, startFailure, type ServiceStarter } from './serviceStart'

/** The helper's named pipe. */
/** Only an administrator can create a pipe under ProtectedPrefix\Administrators, so nobody else can stand in for the service. */
export const HELPER_PIPE = String.raw`\\.\pipe\ProtectedPrefix\Administrators\AmnesiaWG\helper`

const DEFAULT_TIMEOUT_MS = 10_000
/** Starting a tunnel may install the Wintun driver on the first connect. */
export const UP_TIMEOUT_MS = 90_000

const NOT_RUNNING = 'Служба AmnesiaWG не запущена — переустановите приложение'
/** A cold start of the service, including a stop of the previous one still under way. */
const START_TIMEOUT_MS = 10_000
const RETRY_MS = 200

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const notRunning = (err: unknown): boolean => err instanceof HelperError && err.code === 'NOT_RUNNING'

function connectError(err: NodeJS.ErrnoException): Error {
  if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') return new HelperError(NOT_RUNNING, 'NOT_RUNNING')
  if (err.code === 'EACCES' || err.code === 'EPERM') {
    return new HelperError('Нет доступа к службе AmnesiaWG — её пайп открыт только вошедшим в систему пользователям', 'NO_ACCESS')
  }
  return new HelperError(`Не удалось связаться со службой AmnesiaWG: ${err.message}`, 'IO')
}

/**
 * One request per connection: opening a local pipe costs next to nothing, and there is no state to lose.
 *
 * The service runs only while the app does: it is not there when the app starts, and it stops by itself
 * once the app is gone. So a request that finds no pipe starts the service (`start`) and tries again.
 */
export class HelperClient {
  /** Shared by every request that found the service down at the same time: one start, not one each. */
  private starting: Promise<void> | null = null

  constructor(
    private readonly path: string = HELPER_PIPE,
    private readonly start: ServiceStarter | null = null
  ) {}

  async request(req: HelperRequest, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<HelperResponse> {
    try {
      return await this.send(req, timeoutMs)
    } catch (err) {
      if (!notRunning(err) || !this.start) throw err
    }
    const deadline = Date.now() + START_TIMEOUT_MS
    // Kept until the service answers, not just until sc returns: requests that fail a moment later
    // belong to the same start.
    this.starting ??= this.startService(this.start, deadline)
    try {
      await this.starting
      // Started, but the pipe appears a moment later.
      for (;;) {
        try {
          const res = await this.send(req, timeoutMs)
          this.starting = null
          return res
        } catch (err) {
          if (!notRunning(err) || Date.now() >= deadline) throw err
        }
        await sleep(RETRY_MS)
      }
    } catch (err) {
      this.starting = null
      throw err
    }
  }

  private async startService(start: ServiceStarter, deadline: number): Promise<void> {
    for (;;) {
      const code = await start()
      if (startAccepted(code)) return
      const fatal = startFailure(code)
      if (fatal) throw fatal
      // Typically the previous instance is still stopping (it just saw its app go): wait it out.
      if (Date.now() >= deadline) throw new HelperError(`Служба AmnesiaWG не запускается (код ${code}) — переустановите приложение`, 'NOT_RUNNING')
      await sleep(RETRY_MS)
    }
  }

  private send(req: HelperRequest, timeoutMs: number): Promise<HelperResponse> {
    return new Promise((resolve, reject) => {
      const sock = connect({ path: this.path })
      let data = ''
      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        sock.destroy()
        fn()
      }
      const timer = setTimeout(
        () => finish(() => reject(new HelperError('Служба AmnesiaWG не отвечает', 'TIMEOUT'))),
        timeoutMs
      )

      sock.setEncoding('utf8')
      sock.on('connect', () => sock.write(JSON.stringify({ v: PROTOCOL, pid: process.pid, ...req }) + '\n'))
      sock.on('data', (chunk: string) => {
        data += chunk
        const end = data.indexOf('\n')
        if (end === -1) return
        finish(() => {
          let res: HelperResponse
          try {
            res = JSON.parse(data.slice(0, end)) as HelperResponse
          } catch {
            return reject(new HelperError('Служба AmnesiaWG ответила непонятно', 'BAD_RESPONSE'))
          }
          if (!res.ok) return reject(new HelperError(res.error || 'Служба AmnesiaWG вернула ошибку', res.code ?? 'UNKNOWN'))
          resolve(res)
        })
      })
      sock.on('error', (err: NodeJS.ErrnoException) => finish(() => reject(connectError(err))))
      sock.on('close', () => finish(() => reject(new HelperError('Служба AmnesiaWG закрыла соединение без ответа', 'CLOSED'))))
    })
  }
}
