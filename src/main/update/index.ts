import { arch, tmpdir } from 'node:os'
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { app, net } from 'electron'
import { hasCommand, packageHint } from '../linuxPackages'
import { updateFromAppArgs, type WindowBounds } from '../setup/mode'
import { waitForMarker } from './handoff'
import { IPC, type UpdateState } from '../../shared/types'
import { bundleOf, installMacUpdate } from './mac'
import { serverSource, type UpdateOs } from './server'
import { createUpdater, InstallCancelled, noServer, SIMULATED, simulated, type SimulatedUpdate, type UpdateSource, type Updater } from './updater'

export { type Updater } from './updater'

/** The first check waits for the window to settle; after that, a few times a day. */
const FIRST_CHECK_MS = 10_000
const EVERY_MS = 6 * 60 * 60 * 1000

/**
 * server.ts's `os` query parameter on this machine. Linux is built for x64 only (scripts/build-linux.mjs),
 * macOS for Apple Silicon only (the CI runner's .dmg), so another architecture has nothing on the site to
 * update to: null there.
 */
const updateOs = (platform: NodeJS.Platform = process.platform): UpdateOs | null =>
  platform === 'win32'
    ? 'windows'
    : platform === 'linux' && arch() === 'x64'
      ? 'linux'
      : platform === 'darwin' && arch() === 'arm64'
        ? 'macos'
        : null

/**
 * Updates over the air. The site's downloads API says which version is the latest; on Windows and Linux its
 * installer is downloaded and started, on macOS its disk image is unpacked beside the application
 * (update/mac.ts). From `npm run dev`, AWG_UPDATE_SIMULATE plays one of the card's scenarios instead
 * (available, latest, network, revoked, unsupported), and installing plays the update screen.
 */
export function startUpdater(host: {
  send(channel: string, state: UpdateState): void
  log(level: 'info' | 'warn' | 'error', message: string): void
  /** «Обновлять автоматически»: read at every scheduled check, so switching it needs no restart. */
  automatic(): boolean
  /** Simulation only: «Перезапустить и обновить» as this system will show it, updating to `version`. */
  playUpdateScreen(version: string): void
  /** Where the window is, so the installer's opens over it; `maximized` for a window filling the screen. */
  windowState(): { bounds: WindowBounds; maximized: boolean } | null
  /** The server that is connected now, connected again once the new version is up. */
  activeTunnelId(): string | null
}): Updater {
  // An install from a folder put together from the changed files (files.ts) that failed — not one called
  // off — is not tried that way again: until the application restarts, the update is the whole installer.
  // A delta that downloads fine but does not start would otherwise come back on every retry.
  let wholeOnly = false
  const { simulate, os, source } = updateSource({ installed: () => (wholeOnly ? null : installedTree()), log: host.log })

  const install = async (version: string, file: string | undefined): Promise<void> => {
    if (simulate) return host.playUpdateScreen(version)
    if (!file || !os) throw new Error('Установка обновлений ещё не подключена')
    const tree = (await stat(file).catch(() => null))?.isDirectory() === true
    try {
      await installFile(version, file)
    } catch (err) {
      if (tree && !(err instanceof InstallCancelled)) {
        wholeOnly = true
        host.log('warn', 'Обновление по частям не установилось — следующая попытка скачает установщик целиком')
        void rm(file, { recursive: true, force: true }).catch(() => undefined)
      }
      throw err
    }
  }

  const installFile = async (version: string, file: string): Promise<void> => {
    const win = host.windowState()
    if (os === 'macos') {
      // From `npm run dev` the «application» is Electron.app in node_modules: never replaced.
      if (!app.isPackaged) throw new Error('Обновление ставится только в собранное приложение')
      await installMacUpdate(file, version, app.getPath('exe'), {
        bounds: win?.bounds ?? null,
        maximized: win?.maximized ?? false,
        reconnect: host.activeTunnelId()
      })
      app.quit()
      return
    }
    await restartInto(file, { bounds: win?.bounds ?? null, maximized: win?.maximized ?? false, reconnect: host.activeTunnelId() })
  }

  const updater = createUpdater({
    source,
    automatic: host.automatic,
    send: (state) => host.send(IPC.updateState, state),
    log: host.log,
    install
  })

  // Only the scheduled checks obey the switch; «Проверить обновления» always works.
  const scheduled = (): void => {
    if (host.automatic()) void updater.check()
  }
  const first = setTimeout(scheduled, FIRST_CHECK_MS)
  const every = setInterval(scheduled, EVERY_MS)
  first.unref?.()
  every.unref?.()
  return updater
}

/**
 * The installed version's files, for an update put together from them (update/files.ts): the bundle on
 * macOS, the application's folder on Windows and Linux.
 */
function installedTree(): string | null {
  if (!app.isPackaged) return null
  if (process.platform === 'darwin') return bundleOf(app.getPath('exe'))
  return dirname(process.execPath)
}

/** The site for this machine, or AWG_UPDATE_SIMULATE's scenario from `npm run dev`. */
function updateSource(
  opts: { installed?: () => string | null; log?(level: 'info' | 'warn', message: string): void } = {}
): { simulate: boolean; os: UpdateOs | null; source: UpdateSource } {
  const scenario = process.env['AWG_UPDATE_SIMULATE'] as SimulatedUpdate | undefined
  const simulate = !app.isPackaged && scenario !== undefined && SIMULATED.includes(scenario)
  const os = updateOs()
  const source: UpdateSource = simulate
    ? simulated(scenario)
    : os
      ? serverSource({ fetch: net.fetch as typeof fetch, current: app.getVersion(), dir: app.getPath('temp'), os, ...opts })
      : noServer()
  return { simulate, os, source }
}

/**
 * «Обновить» on the installer's «уже установлен» screen (setup/index.ts): one go from the check to the new
 * installer — a version found is downloaded at once and started the way «Перезапустить и обновить» started
 * installers before the seamless update: it waits for this process to quit, then plays its update screen.
 */
export function createSetupUpdater(host: {
  send(state: UpdateState): void
  log(level: 'info' | 'warn' | 'error', message: string): void
}): Updater {
  const { simulate, os, source } = updateSource()
  return createUpdater({
    source,
    automatic: () => true,
    send: host.send,
    log: host.log,
    install: async (_version, file) => {
      if (simulate) throw new Error('Из окна установщика обновление ставится только в собранное приложение')
      if (!file || os === null || os === 'macos') throw new Error('Установка обновлений ещё не подключена')
      await prepareInstaller(file)
      const child = spawn(file, updateFromAppArgs(process.pid), { detached: true, stdio: 'ignore' })
      await new Promise<void>((resolve, reject) => {
        child.once('error', (err) => reject(new Error(`Не удалось запустить установщик: ${err.message}`)))
        child.once('spawn', () => resolve())
      })
      child.unref()
      // The installer takes the single-instance lock once this process is gone (setup/mode.ts, waitForExit).
      app.releaseSingleInstanceLock()
      app.quit()
    }
  })
}

/**
 * What to start for the update: the downloaded installer, or — for a folder put together from the changed
 * files — the new version's own executable in setup mode, the way the installer starts it once it has
 * unpacked itself: the .run (scripts/make-run.sh, --no-sandbox for the same reason — a fresh folder in the
 * user's temporary directory) or the Windows stub (setup mode by PORTABLE_EXECUTABLE_FILE, here --setup).
 * The names are electron-builder.yml's: linux.executableName, and productName on Windows.
 */
async function installerCommand(file: string, args: string[]): Promise<{ exe: string; args: string[] }> {
  if ((await stat(file)).isDirectory()) {
    return process.platform === 'win32'
      ? { exe: join(file, 'SenAWG.exe'), args: ['--setup', ...args] }
      : { exe: join(file, 'senawg'), args: ['--no-sandbox', '--setup', ...args] }
  }
  await prepareInstaller(file)
  return { exe: file, args }
}

/** Linux: the .run unpacks itself with zstd, and a downloaded file carries no exec bit. */
async function prepareInstaller(file: string): Promise<void> {
  if (process.platform !== 'linux') return
  // Without zstd the stub would only say so on a terminal no one sees.
  if (!hasCommand('zstd')) throw new Error(`Для обновления нужен zstd. Установите пакет ${packageHint('zstd')}`)
  await chmod(file, 0o755)
}

/**
 * The downloaded file is the same self-extracting installer as on the site (a .exe on Windows, a .run
 * shell stub on Linux — server.ts picks the right one). Started with `--seamless` it does the slow part
 * while this application keeps running: unpacks, asks for the administrator's rights, copies the new
 * version beside the old one. Only when that is done does its window open over this one and this process
 * quit (handoff.ts), so the person sees a blink, not an installer. A prompt declined or a copy that
 * failed comes back here as a marker, and nothing has changed.
 */
async function restartInto(
  file: string,
  from: { bounds: WindowBounds | null; maximized: boolean; reconnect: string | null }
): Promise<void> {
  const handoff = await mkdtemp(join(tmpdir(), 'senawg-update-'))
  try {
    let exited = false
    const run = await installerCommand(file, updateFromAppArgs(process.pid, { handoff, ...from }))
    const child = spawn(run.exe, run.args, { detached: true, stdio: 'ignore' })
    const started = new Promise<void>((resolve, reject) => {
      child.once('error', (err) => reject(new Error(`Не удалось запустить установщик: ${err.message}`)))
      child.once('spawn', () => resolve())
    })
    child.once('exit', () => (exited = true))
    await started
    child.unref()

    const said = await waitForMarker(handoff, { alive: () => !exited })
    if (said.kind === 'shown') {
      app.quit()
      return
    }
    // The installer is done with: gone already, or told to go.
    if (!exited) child.kill()
    if (said.kind === 'cancelled') throw new InstallCancelled('Обновление отменено: не получены права администратора')
    if (said.kind === 'failed') throw new Error(said.message)
    throw new Error('Установщик не ответил вовремя')
  } finally {
    // Once the application has quit this may not run; the folder is a few empty files in the temp directory.
    void rm(handoff, { recursive: true, force: true }).catch(() => undefined)
  }
}
