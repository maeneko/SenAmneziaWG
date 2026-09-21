import { randomBytes } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import {
  IPC,
  type SetupFailure,
  type SetupInfo,
  type SetupInstallResult,
  type SetupProgress
} from '../../shared/types'
import { ERROR_CANCELLED, runElevated } from './elevate'
import { readInstalledDir } from './mode'
import { ProgressFollower, type SetupEvent } from './progress'

export interface SetupHost {
  info: SetupInfo
  window(): BrowserWindow | null
  /**
   * The service is up: build the application behind the window and load its first screen. Resolves when
   * that screen is ready to be shown, so laying it over the window later is instant.
   */
  prepareApp(): Promise<void>
  /** Lays the prepared application over the window. */
  showApp(): void
}

/**
 * The `setup:*` channels. The screen (src/renderer/installer) drives the whole thing; this is the other
 * end of its bridge. From the packaged installer the work is `awg-helper setup`, elevated; from
 * `npm run dev -- --setup` it is played on made-up timings, so the screen and the handoff to the
 * application can be worked on anywhere (AWG_SETUP_SIMULATE=fail|cancel plays the other endings).
 */
export function registerSetupIpc(host: SetupHost): void {
  const send = (channel: string, payload: SetupProgress | SetupFailure): void =>
    host.window()?.webContents.send(channel, payload)
  const forward = (events: SetupEvent[]): boolean => {
    let failed = false
    for (const e of events) {
      if (e.kind === 'step') send(IPC.setupProgress, { step: e.step, state: e.state })
      else {
        failed = true
        send(IPC.setupFailed, { step: e.step, message: e.message })
      }
    }
    return failed
  }

  let running = false
  let prepared: Promise<void> | null = null

  ipcMain.handle(IPC.setupPickFolder, async (): Promise<string | null> => {
    const win = host.window()
    const options = {
      title: 'Куда установить SenAWG',
      defaultPath: host.info.defaultPath,
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(IPC.setupInstall, async (_e, path: string): Promise<SetupInstallResult> => {
    if (running) return { ok: false, cancelled: false }
    running = true
    try {
      const outcome = app.isPackaged && process.platform === 'win32' ? await installForReal(path, forward, send) : await simulate(send)
      if (outcome === 'cancelled') return { ok: false, cancelled: true }
      if (outcome === 'failed') return { ok: false, cancelled: false }
      // The service is running: the application can be built now, while the screen plays its last beats.
      prepared = host.prepareApp()
      void prepared.catch(() => undefined) // surfaced where it is awaited, in entered
      return { ok: true }
    } finally {
      running = false
    }
  })

  ipcMain.on(IPC.setupEntered, () => {
    void (prepared ?? Promise.resolve()).then(() => host.showApp())
  })
}

type Outcome = 'ok' | 'failed' | 'cancelled'

async function installForReal(
  path: string,
  forward: (events: SetupEvent[]) => boolean,
  send: (channel: string, payload: SetupFailure) => void
): Promise<Outcome> {
  // The unpacked installer: the application, and next to it in resources\win the helper that does the work.
  const from = dirname(process.execPath)
  const helper = join(from, 'resources', 'win', 'awg-helper.exe')
  const progressFile = join(tmpdir(), `awg-setup-${randomBytes(6).toString('hex')}.jsonl`)
  writeFileSync(progressFile, '')
  const follower = new ProgressFollower(progressFile)
  let reportedFailure = false
  const timer = setInterval(() => {
    reportedFailure = forward(follower.read()) || reportedFailure
  }, 150)

  let code: number
  let stderr: string
  try {
    ;({ code, stderr } = await runElevated(helper, ['setup', '--app-from', from, '--app-to', path, '--progress', progressFile]))
  } finally {
    clearInterval(timer)
  }
  reportedFailure = forward(follower.read()) || reportedFailure // whatever came in the last moments
  rmSync(progressFile, { force: true })

  if (code === ERROR_CANCELLED) return 'cancelled'
  if (code !== 0) {
    // The helper says what broke itself; this is only for when it could not even start.
    if (!reportedFailure) {
      send(IPC.setupFailed, { step: 0, message: stderr || `Установщик завершился с кодом ${code}.` })
    }
    return 'failed'
  }
  await addStartMenuShortcut()
  return 'ok'
}

/** In the user's own Start menu: made here, unelevated, so it belongs to the user who will use it. */
async function addStartMenuShortcut(): Promise<void> {
  try {
    const dir = await readInstalledDir()
    if (!dir) return
    shell.writeShortcutLink(join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'SenAWG.lnk'), {
      target: join(dir, 'SenAWG.exe'),
      cwd: dir,
      description: 'SenAWG'
    })
  } catch {
    /* a missing shortcut is not worth failing an install that worked */
  }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function simulate(send: (channel: string, payload: SetupProgress | SetupFailure) => void): Promise<Outcome> {
  const scenario = process.env['AWG_SETUP_SIMULATE'] ?? 'ok'
  await wait(800) // the time the administrator prompt would take
  if (scenario === 'cancel') return 'cancelled'
  for (const step of [0, 1, 2]) {
    send(IPC.setupProgress, { step, state: 'active' })
    await wait(step === 1 ? 1400 : 900)
    if (scenario === 'fail' && step === 1) {
      send(IPC.setupFailed, { step, message: 'Не удалось установить службу SenAWG: Access is denied. Изменения отменены.' })
      return 'failed'
    }
    send(IPC.setupProgress, { step, state: 'done' })
  }
  return 'ok'
}
