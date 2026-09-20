import { app } from 'electron'
import { spawn } from 'node:child_process'
import { basename, join } from 'node:path'
import type { AppOptions } from '../shared/types'
import { defaultInstallDir, readInstalledDir } from './setup/mode'

/**
 * The two switches that belong to the operating system rather than to the application, and — on Windows
 * — the way out of it.
 */
export const supported = (platform: NodeJS.Platform = process.platform): boolean =>
  platform === 'win32' || platform === 'darwin'

/**
 * Uninstalling is a Windows affair: there the application is a service, a folder under Program Files and
 * a handful of registry keys, and something has to take them apart. A macOS application is dragged into
 * Программы and thrown away the same way, so offering a button for it would be pretending to do work.
 */
export const canUninstall = (platform: NodeJS.Platform = process.platform): boolean => platform === 'win32'

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

/**
 * Which login item to look at. `path` and `args` are Windows-only; on macOS the item is the application
 * bundle itself, which is what SMAppService registers, and naming the binary inside it would be wrong.
 */
async function loginItem(): Promise<{ path?: string; args?: string[] }> {
  return process.platform === 'win32' ? { path: await loginExe(), args: [] } : {}
}

export async function readAppOptions(): Promise<AppOptions> {
  if (!supported()) return { supported: false, canUninstall: false, autoStart: false }
  return {
    supported: true,
    canUninstall: canUninstall(),
    autoStart: app.getLoginItemSettings(await loginItem()).openAtLogin
  }
}

/** Returns what the system says afterwards, not what was asked: the switch shows the truth. */
export async function writeAutoStart(enabled: boolean): Promise<boolean> {
  if (!supported()) return false
  const item = await loginItem()
  app.setLoginItemSettings({ openAtLogin: enabled, ...item })
  return app.getLoginItemSettings(item).openAtLogin
}

/**
 * Hands over to `awg-helper remove`, which asks for administrator rights itself, stops the tunnel and
 * the services, and closes this application on its way. Nothing is quit here: if the user turns the
 * prompt down, the application must still be running afterwards, exactly as it was.
 */
export function startUninstall(): void {
  if (!canUninstall()) return
  spawn(helperPath(), ['remove'], { detached: true, stdio: 'ignore' }).unref()
}
