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
import { runElevatedLinux } from '../setup/elevateLinux'
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
 * «Удалить SenAWG» from the application. The work is `awg-helper remove --progress`, elevated, as the
 * setup is `awg-helper setup`; the application stays on screen to show it and is closed by the user
 * («Завершить»), after which the helper removes its folder. From `npm run dev` it is played on made-up
 * timings (AWG_UNINSTALL_SIMULATE=ok|fail|cancel), so the screen can be worked on anywhere.
 */
export function createUninstaller(host: UninstallHost): { start(keepData: boolean): Promise<UninstallResult>; finish(): void } {
  let running = false
  let wipeOnExit = false
  const real = app.isPackaged && (process.platform === 'win32' || process.platform === 'linux')

  return {
    async start(keepData) {
      if (running) return 'cancelled'
      running = true
      host.pause()
      host.log('warn', `Запрошено удаление SenAWG (${keepData ? 'серверы и ключи сохраняются' : 'серверы и ключи стираются'})`)
      try {
        const result = real ? await removeForReal(keepData, host) : await simulate(host)
        if (result === 'done') wipeOnExit = real && !keepData
        else host.resume()
        if (result === 'cancelled') host.log('info', 'Удаление отменено: не получены права администратора')
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
  // Pre-created on Windows only: on Linux `awg-helper remove` (root, via pkexec) creates it itself —
  // see the note by setup/index.ts's installForRealLinux for why a file this unprivileged process
  // creates can end up one root cannot open on some distributions.
  if (process.platform !== 'linux') writeFileSync(file, '')
  const follower = new ProgressFollower(file)
  // Keys the service kept (Linux with no keyring, store.ts) stay only if the servers stay.
  const keep = process.platform === 'linux' && keepData ? ['--keep-secrets'] : []
  try {
    return await followRemoval({
      run: () =>
        process.platform === 'linux'
          ? runElevatedLinux(helperPath(), ['remove', '--progress', file, ...keep])
          : runElevated(helperPath(), ['remove', '--progress', file]),
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
  // The Start-menu shortcut (Windows) and the desktop icon the installer offered (Windows .lnk, Linux .desktop).
  const shortcuts = [
    join(app.getPath('desktop'), process.platform === 'win32' ? 'SenAWG.lnk' : 'senawg.desktop'),
    ...(process.platform === 'win32'
      ? [join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'SenAWG.lnk')]
      : [])
  ]
  for (const file of shortcuts) {
    try {
      rmSync(file, { force: true })
    } catch {
      /* a shortcut left behind points nowhere; not worth failing a removal that worked */
    }
  }
  void writeAutoStart(false).catch(() => undefined)
}

/**
 * The rest of the profile folder (Chromium's own files) is held open until this process exits, so it is
 * removed a moment after, by a detached shell of the same user.
 */
function removeAfterExit(dir: string): void {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/d', '/s', '/c', `"timeout /t 3 /nobreak >nul & rmdir /s /q "${dir}""`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true
    }).unref()
    return
  }
  if (process.platform === 'linux') {
    spawn('/bin/sh', ['-c', `sleep 3; rm -rf ${quoteShArg(dir)}`], { detached: true, stdio: 'ignore' }).unref()
  }
}

/** A single POSIX shell argument, quoted so a path with spaces or a stray `'` is still one argument. */
const quoteShArg = (arg: string): string => `'${arg.replaceAll("'", `'\\''`)}'`

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function simulate(host: UninstallHost): Promise<UninstallResult> {
  const scenario = process.env['AWG_UNINSTALL_SIMULATE'] ?? 'ok'
  await wait(1200) // the time the administrator prompt would take
  if (scenario === 'cancel') return 'cancelled'
  for (const step of [0, 1, 2]) {
    host.send(IPC.uninstallProgress, { step, state: 'active' })
    await wait(step === 1 ? 1400 : 1000)
    if (scenario === 'fail' && step === 1) {
      host.send(IPC.uninstallFailed, { step, message: 'Не удалось удалить службу SenAWG: служба не останавливается. Перезагрузите компьютер и повторите удаление.' })
      return 'failed'
    }
    host.send(IPC.uninstallProgress, { step, state: 'done' })
  }
  return 'done'
}
