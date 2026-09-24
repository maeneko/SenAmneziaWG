import { execFile } from 'node:child_process'
import { HelperError } from '../windows/protocol'
import type { HelperStarter } from '../windows/helperClient'

/**
 * Starting the helper on Linux: pkexec, gated by the polkit action `ru.senawg.helper.service`
 * (helper/setup_linux.go writes the policy, `allow_active: yes` on it — no password for an interactive
 * user, only a one-time consent the desktop may still show once per session; see docs/linux.md).
 */
// Same layout appOptions.ts's helperPath() computes: electron-builder.yml's linux.extraResources
// (`to: linux`) is what puts the binary under resources/linux inside the installed tree.
export const HELPER_PATH = (env: NodeJS.ProcessEnv = process.env): string =>
  `${env['SENAWG_APP_DIR'] ?? '/opt/SenAWG'}/resources/linux/awg-helper`

/** pkexec's own exit codes (its manual page): 126 the user dismissed the prompt, 127 not authorized. */
const PKEXEC_DISMISSED = 126
const PKEXEC_NOT_AUTHORIZED = 127
/** Not pkexec's own: it could not be run at all, or did not finish in time. */
const PKEXEC_UNAVAILABLE = -1
const PKEXEC_TIMED_OUT = -2

export const pkexecStart = (helperPath = HELPER_PATH()): HelperStarter['start'] =>
  () =>
    new Promise((resolve) => {
      execFile('pkexec', [helperPath, 'service'], { timeout: 10_000 }, (err) => {
        // `awg-helper service` (no --daemon) returns as soon as the real, detached service answers on
        // its socket (main_linux.go: runServiceLauncher) — it does not block for as long as the service
        // runs, the same shape sc.exe start has on Windows.
        if (!err) return resolve(0)
        if (typeof err.code === 'number') return resolve(err.code)
        resolve(err.killed ? PKEXEC_TIMED_OUT : PKEXEC_UNAVAILABLE)
      })
    })

export const pkexecAccepted = (code: number): boolean => code === 0

export function pkexecFailure(code: number): HelperError | null {
  switch (code) {
    case PKEXEC_DISMISSED:
      return new HelperError('Подключение отменено', 'CANCELLED')
    case PKEXEC_NOT_AUTHORIZED:
      return new HelperError('Недостаточно прав для запуска службы SenAWG', 'NO_ACCESS')
    case PKEXEC_UNAVAILABLE:
      return new HelperError(
        'Не найден pkexec — установите polkit, без него SenAWG не может подключаться',
        'NOT_RUNNING'
      )
    default:
      return null
  }
}

export const linuxStarter = (helperPath?: string): HelperStarter => ({
  start: pkexecStart(helperPath),
  accepted: pkexecAccepted,
  failure: pkexecFailure
})
