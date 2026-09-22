import { spawn } from 'node:child_process'
import { app } from 'electron'
import { updateFromAppArgs } from '../setup/mode'
import { IPC, type UpdateState } from '../../shared/types'
import { createUpdater, noServer, SIMULATED, simulated, type SimulatedUpdate, type Updater } from './updater'

export { type Updater } from './updater'

/** The first check waits for the window to settle; after that, a few times a day. */
const FIRST_CHECK_MS = 10_000
const EVERY_MS = 6 * 60 * 60 * 1000

/**
 * Updates over the air — for now a stub: there is no server to download from, so a check always ends in
 * «Обновлений нет» and nothing is ever installed. From `npm run dev`, AWG_UPDATE_SIMULATE plays one of
 * the card's scenarios instead (available, latest, network, revoked, unsupported), and installing plays
 * the update screen.
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

  const updater = createUpdater({
    source: simulate ? simulated(scenario) : noServer(),
    automatic: host.automatic,
    send: (state) => host.send(IPC.updateState, state),
    log: host.log,
    install: async (_version, file) => {
      if (simulate) return host.playUpdateScreen()
      if (!file || process.platform !== 'win32') throw new Error('Установка обновлений ещё не подключена')
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
 * Windows: the downloaded file is the same self-extracting installer as on the site. Started with
 * updateFromAppArgs it opens straight on the update screen, already at work, once this process is gone —
 * so this one quits as soon as the installer is known to have started.
 */
function restartInto(file: string): Promise<void> {
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
