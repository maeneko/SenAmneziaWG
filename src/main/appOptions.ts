import { app } from 'electron'
import { basename, join } from 'node:path'
import type { AppOptions } from '../shared/types'
import { defaultInstallDir, readInstalledDir } from './setup/mode'

/**
 * The two switches that belong to the operating system rather than to the application, and — on Windows
 * and Linux — the way out of it.
 */
export const supported = (platform: NodeJS.Platform = process.platform): boolean =>
  platform === 'win32' || platform === 'darwin' || platform === 'linux'

/**
 * Uninstalling is a Windows-and-Linux affair: there the application is a service, files under a system
 * directory and a handful of registration entries (the registry, or /etc/senawg/install.json), and
 * something has to take them apart. A macOS application is dragged into Программы and thrown away the
 * same way, so offering a button for it would be pretending to do work.
 */
export const canUninstall = (platform: NodeJS.Platform = process.platform, simulated = simulatedUninstall()): boolean =>
  platform === 'win32' || platform === 'linux' || simulated

/** `npm run dev` with AWG_UNINSTALL_SIMULATE: the removal screen on any system, on made-up timings. */
const simulatedUninstall = (): boolean => !app.isPackaged && Boolean(process.env['AWG_UNINSTALL_SIMULATE'])

/**
 * The helper of an installed copy. On Windows its own files never leave Program Files, whatever folder
 * was picked (setup_windows.go's serviceDir); on Linux setup_linux.go copies the whole unpacked
 * application tree as is (electron-builder.yml's `linux.extraResources`, `to: linux`, is what puts it
 * under resources/linux in the first place — see scripts/build-helper-linux.mjs), into a fixed
 * /opt/SenAWG — the installer offers no other choice there.
 */
export const helperPath = (env: NodeJS.ProcessEnv = process.env): string =>
  process.platform === 'linux'
    ? join(defaultInstallDir(env, 'linux'), 'resources', 'linux', 'awg-helper')
    : join(defaultInstallDir(env), 'awg-helper.exe')

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
 * On Linux, Electron writes a .desktop file to ~/.config/autostart itself and needs no path either.
 */
async function loginItem(): Promise<{ path?: string; args?: string[] }> {
  return process.platform === 'win32' ? { path: await loginExe(), args: [] } : {}
}

/** Run in background / tray: needs a tray icon to reopen from, which is only wired up on Windows and Linux. */
export const canRunInBackground = (platform: NodeJS.Platform = process.platform): boolean =>
  platform === 'win32' || platform === 'linux'

export async function readAppOptions(): Promise<AppOptions> {
  if (!supported()) return { supported: false, canUninstall: false, autoStart: false, canRunInBackground: false }
  return {
    supported: true,
    canUninstall: canUninstall(),
    autoStart: app.getLoginItemSettings(await loginItem()).openAtLogin,
    canRunInBackground: canRunInBackground()
  }
}

/** Returns what the system says afterwards, not what was asked: the switch shows the truth. */
export async function writeAutoStart(enabled: boolean): Promise<boolean> {
  if (!supported()) return false
  const item = await loginItem()
  app.setLoginItemSettings({ openAtLogin: enabled, ...item })
  return app.getLoginItemSettings(item).openAtLogin
}
