import { arch, tmpdir } from 'node:os'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { app, net } from 'electron'
import { updateFromAppArgs, type WindowBounds } from '../setup/mode'
import { waitForMarker } from './handoff'
import { IPC, type UpdateState } from '../../shared/types'
import { serverSource } from './server'
import { createUpdater, InstallCancelled, noServer, SIMULATED, simulated, type SimulatedUpdate, type UpdateSource, type Updater } from './updater'

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
  /** Where the window is, so the installer's opens over it. */
  windowBounds(): WindowBounds | null
  /** The server that is connected now, connected again once the new version is up. */
  activeTunnelId(): string | null
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
      await restartInto(file, { bounds: host.windowBounds(), reconnect: host.activeTunnelId() })
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
 * shell stub on Linux — server.ts picks the right one). Started with `--seamless` it does the slow part
 * while this application keeps running: unpacks, asks for the administrator's rights, copies the new
 * version beside the old one. Only when that is done does its window open over this one and this process
 * quit (handoff.ts), so the person sees a blink, not an installer. A prompt declined or a copy that
 * failed comes back here as a marker, and nothing has changed.
 */
async function restartInto(file: string, from: { bounds: WindowBounds | null; reconnect: string | null }): Promise<void> {
  if (process.platform === 'linux') await chmod(file, 0o755) // downloaded files carry no exec bit
  const handoff = await mkdtemp(join(tmpdir(), 'senawg-update-'))
  try {
    let exited = false
    const child = spawn(file, updateFromAppArgs(process.pid, { handoff, ...from }), { detached: true, stdio: 'ignore' })
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
