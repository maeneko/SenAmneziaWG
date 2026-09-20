import { app } from 'electron'
import { spawn } from 'node:child_process'
import { basename, join } from 'node:path'
import type { AppOptions } from '../shared/types'
import { defaultInstallDir, readInstalledDir } from './setup/mode'

/**
 * The two switches that belong to the operating system rather than to the application, and the way out
 * of it. Windows only for now: on macOS the application is dragged into Программы and thrown away the
 * same way, and there is nothing here for it to do.
 */
export const supported = (): boolean => process.platform === 'win32'

/** The helper of an installed copy. Its own files never leave Program Files, whatever folder was picked. */
export const helperPath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(defaultInstallDir(env), 'awg-helper.exe')

/**
 * Which exe Windows should start at login — not always this one. Right after an install the window is
 * still the temporary copy the downloaded installer unpacked, and a login item pointing into %TEMP%
 * would break the first time Windows clears it. The registry knows where the application really went.
 */
export async function loginExe(): Promise<string> {
  const dir = await readInstalledDir()
  return dir ? join(dir, basename(process.execPath)) : process.execPath
}

export async function readAppOptions(): Promise<AppOptions> {
  if (!supported()) return { supported: false, autoStart: false }
  const path = await loginExe()
  return { supported: true, autoStart: app.getLoginItemSettings({ path }).openAtLogin }
}

/** Returns what the system says afterwards, not what was asked: the switch shows the truth. */
export async function writeAutoStart(enabled: boolean): Promise<boolean> {
  if (!supported()) return false
  const path = await loginExe()
  app.setLoginItemSettings({ openAtLogin: enabled, path, args: [] })
  return app.getLoginItemSettings({ path }).openAtLogin
}

/**
 * Hands over to `awg-helper remove`, which asks for administrator rights itself, stops the tunnel and
 * the services, and closes this application on its way. Nothing is quit here: if the user turns the
 * prompt down, the application must still be running afterwards, exactly as it was.
 */
export function startUninstall(): void {
  spawn(helperPath(), ['remove'], { detached: true, stdio: 'ignore' }).unref()
}
