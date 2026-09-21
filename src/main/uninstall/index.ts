import { app } from 'electron'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IPC, type SetupFailure, type SetupProgress, type UninstallResult } from '../../shared/types'
import { helperPath, writeAutoStart } from '../appOptions'
import { forgetSettings } from '../settings'
import { runElevated } from '../setup/elevate'
import { ProgressFollower } from '../setup/progress'
import { forgetTunnels } from '../store'
import { followRemoval } from './follow'

export interface UninstallHost {
  send(channel: string, payload: SetupProgress | SetupFailure): void
  /** The removal screen is up: nothing may talk to the service any more — it would start it again. */
  pause(): void
  /** Back in the application after a declined prompt or a failure. */
  resume(): void
  log(level: 'info' | 'warn' | 'error', message: string): void
}

/**
 * «Удалить AmnesiaWG» from the application. The work is `awg-helper remove --progress`, elevated, as the
 * setup is `awg-helper setup`; the application stays on screen to show it and is closed by the user
 * («Завершить»), after which the helper removes its folder. From `npm run dev` it is played on made-up
 * timings (AWG_UNINSTALL_SIMULATE=ok|fail|cancel), so the screen can be worked on anywhere.
 */
export function createUninstaller(host: UninstallHost): { start(keepData: boolean): Promise<UninstallResult>; finish(): void } {
  let running = false
  let wipeOnExit = false
  const real = app.isPackaged && process.platform === 'win32'

  return {
    async start(keepData) {
      if (running) return 'cancelled'
      running = true
      host.pause()
      host.log('warn', `Запрошено удаление AmnesiaWG (${keepData ? 'серверы и ключи сохраняются' : 'серверы и ключи стираются'})`)
      try {
        const result = real ? await removeForReal(keepData, host) : await simulate(host)
        if (result === 'done') wipeOnExit = real && !keepData
        else host.resume()
        if (result === 'cancelled') host.log('info', 'Удаление отменено: Windows не получила прав администратора')
        return result
      } finally {
        running = false
      }
    },
    finish() {
      if (wipeOnExit) removeAfterExit(app.getPath('userData'))
      app.quit()
    }
  }
}

async function removeForReal(keepData: boolean, host: UninstallHost): Promise<UninstallResult> {
  const file = join(tmpdir(), `awg-remove-${randomBytes(6).toString('hex')}.jsonl`)
  writeFileSync(file, '')
  const follower = new ProgressFollower(file)
  try {
    return await followRemoval({
      run: () => runElevated(helperPath(), ['remove', '--progress', file]),
      read: () => follower.read(),
      beforeLastDone: () => {
        forgetInstall()
        if (!keepData) {
          forgetTunnels()
          forgetSettings()
        }
      },
      onProgress: (e) => host.send(IPC.uninstallProgress, e),
      onFailed: (e) => {
        host.log('error', `Удаление не удалось: ${e.message}`)
        host.send(IPC.uninstallFailed, e)
      }
    })
  } finally {
    try {
      rmSync(file, { force: true })
    } catch {
      /* still held by the helper for a moment: %TEMP% takes care of it */
    }
  }
}

/**
 * What the application itself put in the user's profile, so it goes from here, unelevated: the helper
 * may be running as another account (an administrator's credentials typed into the prompt).
 */
function forgetInstall(): void {
  try {
    rmSync(join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'AmnesiaWG.lnk'), { force: true })
  } catch {
    /* a shortcut left behind points nowhere; not worth failing a removal that worked */
  }
  void writeAutoStart(false).catch(() => undefined)
}

/**
 * The rest of the profile folder (Chromium's own files) is held open until this process exits, so it is
 * removed a moment after, by a detached shell of the same user.
 */
function removeAfterExit(dir: string): void {
  if (process.platform !== 'win32') return
  spawn('cmd.exe', ['/d', '/s', '/c', `"timeout /t 3 /nobreak >nul & rmdir /s /q "${dir}""`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    windowsVerbatimArguments: true
  }).unref()
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function simulate(host: UninstallHost): Promise<UninstallResult> {
  const scenario = process.env['AWG_UNINSTALL_SIMULATE'] ?? 'ok'
  await wait(1200) // the time the administrator prompt would take
  if (scenario === 'cancel') return 'cancelled'
  for (const step of [0, 1, 2]) {
    host.send(IPC.uninstallProgress, { step, state: 'active' })
    await wait(step === 1 ? 1400 : 1000)
    if (scenario === 'fail' && step === 1) {
      host.send(IPC.uninstallFailed, { step, message: 'Не удалось удалить службу AmnesiaWG: служба не останавливается. Перезагрузите компьютер и повторите удаление.' })
      return 'failed'
    }
    host.send(IPC.uninstallProgress, { step, state: 'done' })
  }
  return 'done'
}
