import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import { HelperError } from './protocol'

/** Registered by the installer (helper/service_windows.go, managerServiceName). */
export const SERVICE_NAME = 'SenAWGHelper'

/** Asks the SCM to start the service; resolves with the Win32 error code, 0 on success. */
export type ServiceStarter = () => Promise<number>

const ERROR_ACCESS_DENIED = 5
const ERROR_SERVICE_ALREADY_RUNNING = 1056
const ERROR_SERVICE_DISABLED = 1058
const ERROR_SERVICE_DOES_NOT_EXIST = 1060
/** Not Win32 codes: sc.exe itself could not be run, or did not finish in time. */
const SC_UNAVAILABLE = -1
const SC_TIMED_OUT = -2

/**
 * The service starts on demand and stops once the app is gone; the installer lets interactive users
 * start it (helper/service_windows.go, serviceSDDL), so no UAC prompt is involved. sc.exe is called by
 * its full path, never looked up on PATH. Its exit code is the Win32 error (its text is localized).
 */
export const scStart: ServiceStarter = () =>
  new Promise((resolve) => {
    const sc = win32.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'sc.exe')
    execFile(sc, ['start', SERVICE_NAME], { windowsHide: true, timeout: 10_000 }, (err) => {
      if (!err) return resolve(0)
      if (typeof err.code === 'number') return resolve(err.code)
      resolve(err.killed ? SC_TIMED_OUT : SC_UNAVAILABLE)
    })
  })

/** Whether the service is up or on its way; anything else not fatal (e.g. still stopping) is retried. */
export const startAccepted = (code: number): boolean => code === 0 || code === ERROR_SERVICE_ALREADY_RUNNING

/** A code no retry will change, as the error the user sees; null when it is worth trying again. */
export function startFailure(code: number): HelperError | null {
  switch (code) {
    case ERROR_SERVICE_DOES_NOT_EXIST:
      return new HelperError('Служба SenAWG не установлена — переустановите приложение', 'NOT_INSTALLED')
    case ERROR_ACCESS_DENIED:
      // Installs from before on-demand start did not let users start the service.
      return new HelperError('Приложению не разрешено запускать службу SenAWG — обновите SenAWG', 'NO_ACCESS')
    case SC_UNAVAILABLE:
      // No file, or blocked by policy: trying again changes nothing.
      return new HelperError('Служба SenAWG не запущена, и запустить её не удалось — переустановите приложение', 'NOT_RUNNING')
    case ERROR_SERVICE_DISABLED:
      return new HelperError('Служба SenAWG отключена в «Службах» Windows — включите её (тип запуска «Вручную»)', 'DISABLED')
    default:
      return null
  }
}
