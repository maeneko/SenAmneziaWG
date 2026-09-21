import { execFile } from 'node:child_process'

/**
 * Setup mode: this process is the installer's window, not the application. It is what the downloaded
 * exe starts after unpacking itself (electron-builder's portable target sets PORTABLE_EXECUTABLE_FILE),
 * and what `--setup` asks for by hand — `npm run dev -- --setup` plays the screen without a Windows machine.
 */
export function isSetupMode(argv: readonly string[], env: NodeJS.ProcessEnv): boolean {
  return argv.includes('--setup') || Boolean(env['PORTABLE_EXECUTABLE_FILE'])
}

/** Where the express install puts the application. */
export function defaultInstallDir(env: NodeJS.ProcessEnv = process.env): string {
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

/** Where a previous install put the application — its presence turns the screen into an update. */
export function readInstalledDir(): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile('reg.exe', ['query', 'HKLM\\SOFTWARE\\SenAWG', '/v', 'AppPath'], { windowsHide: true }, (err, stdout) => {
      resolve(err ? null : parseRegQuery(stdout))
    })
  })
}
