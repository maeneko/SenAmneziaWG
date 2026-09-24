import { arch } from 'node:os'
import { chmod } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { app, net } from 'electron'
import { updateFromAppArgs } from '../setup/mode'
import { IPC, type UpdateState } from '../../shared/types'
import { serverSource } from './server'
import { createUpdater, noServer, SIMULATED, simulated, type SimulatedUpdate, type UpdateSource, type Updater } from './updater'

export { type Updater } from './updater'

/** The first check waits for the window to settle; after that, a few times a day. */
const FIRST_CHECK_MS = 10_000
const EVERY_MS = 6 * 60 * 60 * 1000

/**
 * server.ts's `os` query parameter on this machine, arch-specific only on Linux, where the site keeps a
 * separate .run per architecture (scripts/build-helper-linux.mjs, electron-builder.yml's linux target).
 * null on a platform with no entry on the site (macOS).
 */
const updateOs = (platform: NodeJS.Platform = process.platform): string | null =>
  platform === 'win32' ? 'windows' : platform === 'linux' ? `linux-${arch() === 'arm64' ? 'arm64' : 'x64'}` : null

/**
 * Updates over the air. On Windows and Linux the site's downloads API says which version is the latest,
 * and its installer is downloaded and started; macOS has no entry there, so a check always ends in
 * «Обновлений нет». From `npm run dev`, AWG_UPDATE_SIMULATE plays one of the card's scenarios instead
 * (available, latest, network, revoked, unsupported), and installing plays the update screen.
 */
export function startUpdater(host: {
  send(channel: string, state: UpdateState): void
  log(level: 'info' | 'warn' | 'error', message: string): void
  /** «Обновлять автоматически»: read at every scheduled check, so switching it needs no restart. */
  automatic(): boolean
  /** Simulation only: the update screen in place of the window, as «Перезапустить и обновить» will show it. */
  playUpdateScreen(): void
}): Updater {
  const scenario = process.env['AWG_UPDATE_SIMULATE'] as SimulatedUpdate | undefined
  const simulate = !app.isPackaged && scenario !== undefined && SIMULATED.includes(scenario)
  const os = updateOs()

  const source: UpdateSource = simulate
    ? simulated(scenario)
    : os
      ? serverSource({ fetch: net.fetch as typeof fetch, current: app.getVersion(), dir: app.getPath('temp'), os })
      : noServer()

  const updater = createUpdater({
    source,
    automatic: host.automatic,
    send: (state) => host.send(IPC.updateState, state),
    log: host.log,
    install: async (_version, file) => {
      if (simulate) return host.playUpdateScreen()
      if (!file || !os) throw new Error('Установка обновлений ещё не подключена')
      await restartInto(file)
    }
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
 * The downloaded file is the same self-extracting installer as on the site (a .exe on Windows, a .run
 * shell stub on Linux — server.ts picks the right one). Started with updateFromAppArgs it opens
 * straight on the update screen, already at work, once this process is gone — so this one quits as
 * soon as the installer is known to have started.
 */
async function restartInto(file: string): Promise<void> {
  if (process.platform === 'linux') await chmod(file, 0o755) // downloaded files carry no exec bit
  return new Promise((resolve, reject) => {
    const child = spawn(file, updateFromAppArgs(process.pid), { detached: true, stdio: 'ignore' })
    child.once('error', (err) => reject(new Error(`Не удалось запустить установщик: ${err.message}`)))
    child.once('spawn', () => {
      child.unref()
      resolve()
      app.quit()
    })
  })
}
