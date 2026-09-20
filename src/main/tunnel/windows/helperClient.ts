import { connect } from 'node:net'
import { HelperError, PROTOCOL, type HelperRequest, type HelperResponse } from './protocol'

/** The helper's named pipe. */
/** Only an administrator can create a pipe under ProtectedPrefix\Administrators, so nobody else can stand in for the service. */
export const HELPER_PIPE = String.raw`\\.\pipe\ProtectedPrefix\Administrators\AmnesiaWG\helper`

const DEFAULT_TIMEOUT_MS = 10_000
/** Starting a tunnel may install the Wintun driver on the first connect. */
export const UP_TIMEOUT_MS = 90_000

const NOT_RUNNING = 'Служба AmnesiaWG не запущена — переустановите приложение'

function connectError(err: NodeJS.ErrnoException): Error {
  if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') return new HelperError(NOT_RUNNING, 'NOT_RUNNING')
  if (err.code === 'EACCES' || err.code === 'EPERM') {
    return new HelperError('Нет доступа к службе AmnesiaWG — её пайп открыт только вошедшим в систему пользователям', 'NO_ACCESS')
  }
  return new HelperError(`Не удалось связаться со службой AmnesiaWG: ${err.message}`, 'IO')
}

/** One request per connection: opening a local pipe costs next to nothing, and there is no state to lose. */
export class HelperClient {
  constructor(private readonly path: string = HELPER_PIPE) {}

  request(req: HelperRequest, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<HelperResponse> {
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
      sock.on('connect', () => sock.write(JSON.stringify({ v: PROTOCOL, ...req }) + '\n'))
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
