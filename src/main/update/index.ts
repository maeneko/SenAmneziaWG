import { app } from 'electron'
import { IPC, type UpdateState } from '../../shared/types'
import { createUpdater, noServer, SIMULATED, simulated, type SimulatedUpdate, type Updater } from './updater'

export { type Updater } from './updater'

/** The first check waits for the window to settle; after that, a few times a day. */
const FIRST_CHECK_MS = 10_000
const EVERY_MS = 6 * 60 * 60 * 1000

/**
 * Updates over the air — for now a stub: there is no server to download from, so a check always ends in
 * «Обновлений нет» and nothing is ever installed. From `npm run dev`, AWG_UPDATE_SIMULATE plays one of
 * the card's scenarios instead (available, latest, network, revoked, unsupported).
 */
export function startUpdater(host: {
  send(channel: string, state: UpdateState): void
  log(level: 'info' | 'warn' | 'error', message: string): void
  /** «Обновлять автоматически»: read at every scheduled check, so switching it needs no restart. */
  automatic(): boolean
}): Updater {
  const scenario = process.env['AWG_UPDATE_SIMULATE'] as SimulatedUpdate | undefined
  const simulate = !app.isPackaged && scenario !== undefined && SIMULATED.includes(scenario)

  const updater = createUpdater({
    source: simulate ? simulated(scenario) : noServer(),
    automatic: host.automatic,
    send: (state) => host.send(IPC.updateState, state),
    log: host.log,
    install: async () => {
      if (!simulate) throw new Error('Установка обновлений ещё не подключена')
      // The real one will close the application into the installer; the simulation just comes back.
      await new Promise((r) => setTimeout(r, 2500))
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
