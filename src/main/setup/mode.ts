import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'

/** Where helper/setup_linux.go's `register` writes what it installed (registry.go's Linux counterpart). */
export const LINUX_INSTALL_JSON = '/etc/senawg/install.json'

/**
 * Setup mode: this process is the installer's window, not the application. It is what the downloaded
 * exe starts after unpacking itself (electron-builder's portable target sets PORTABLE_EXECUTABLE_FILE;
 * the Linux `.run` stub sets SENAWG_RUN_FILE the same way, see scripts/make-run.sh), and what `--setup`
 * asks for by hand — `npm run dev -- --setup` plays the screen without installing anything.
 */
export function isSetupMode(argv: readonly string[], env: NodeJS.ProcessEnv): boolean {
  return argv.includes('--setup') || Boolean(env['PORTABLE_EXECUTABLE_FILE']) || Boolean(env['SENAWG_RUN_FILE'])
}

/** Where the express install puts the application. */
export function defaultInstallDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'linux') return '/opt/SenAWG'
  return `${env['ProgramFiles'] ?? 'C:\\Program Files'}\\SenAWG`
}

/**
 * `reg query` prints «    AppPath    REG_SZ    D:\Programs\SenAWG». The value may hold spaces, so it is taken
 * as everything after the type, not as a column.
 */
export function parseRegQuery(stdout: string): string | null {
  const match = /^\s*AppPath\s+REG_SZ\s+(.+?)\s*$/m.exec(stdout)
  return match ? match[1] : null
}

/** helper/setup_linux.go's installInfo, read back the way parseRegQuery reads the registry. */
export function parseInstallJSON(text: string): string | null {
  try {
    const info = JSON.parse(text) as { appPath?: unknown }
    return typeof info.appPath === 'string' && info.appPath ? info.appPath : null
  } catch {
    return null
  }
}

/** Where a previous install put the application — its presence turns the screen into an update. */
export function readInstalledDir(): Promise<string | null> {
  if (process.platform === 'linux') {
    return readFile(LINUX_INSTALL_JSON, 'utf8').then(parseInstallJSON).catch(() => null)
  }
  if (process.platform !== 'win32') return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile('reg.exe', ['query', 'HKLM\\SOFTWARE\\SenAWG', '/v', 'AppPath'], { windowsHide: true }, (err, stdout) => {
      resolve(err ? null : parseRegQuery(stdout))
    })
  })
}

/**
 * «Перезапустить и обновить»: the application starts the downloaded installer with these and quits. The
 * installer then plays the update screen without asking again, once that application is gone — it holds
 * the single-instance lock and the files about to be replaced.
 */
const FROM_APP = '--update-from-app'
const WAIT_PID = '--wait-pid='

export function updateFromAppArgs(pid: number): string[] {
  return [FROM_APP, `${WAIT_PID}${pid}`]
}

export function isUpdateFromApp(argv: readonly string[]): boolean {
  return argv.includes(FROM_APP)
}

/** The application to wait for, if this was started by one. */
export function waitPidOf(argv: readonly string[]): number | null {
  const arg = argv.find((a) => a.startsWith(WAIT_PID))
  const pid = arg ? Number(arg.slice(WAIT_PID.length)) : NaN
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/** Resolves once `pid` has exited, or after `timeoutMs` whatever it is doing. */
export async function waitForExit(pid: number | null, timeoutMs = 15_000, stepMs = 100): Promise<void> {
  if (pid === null) return
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    try {
      process.kill(pid, 0)
    } catch {
      return // ESRCH: gone (EPERM cannot happen for our own user's process)
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}
