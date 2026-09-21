import type { SetupFailure, SetupProgress, UninstallResult } from '../../shared/types'
import type { ElevatedResult } from '../setup/elevate'
import { ERROR_CANCELLED } from '../setup/elevate'
import type { SetupEvent } from '../setup/progress'

/** The removal screen's steps (helper/internal/setup/remove.go — the numbers must agree). */
export const REMOVE_STEPS = 3
const LAST_STEP = REMOVE_STEPS - 1

export interface FollowDeps {
  /** Runs `awg-helper remove --progress <file>` behind the administrator prompt. */
  run(): Promise<ElevatedResult>
  /** What the helper has appended to the progress file since the last call. */
  read(): SetupEvent[]
  /**
   * Called before the last step is reported done, so that the screen's «Файлы программы, серверы и
   * ключи» is only ticked once the keys are really gone. Throwing turns the step into a failure.
   */
  beforeLastDone(): void
  onProgress(e: SetupProgress): void
  onFailed(e: SetupFailure): void
  /** How often the file is read, and how long the helper may say nothing before it counts as stuck. */
  pollMs?: number
  idleMs?: number
  now?: () => number
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Follows a removal to its end. The installed helper cannot delete the file it runs from, so it copies
 * itself to %TEMP% and exits at once: the elevated process ending says nothing about the removal, and
 * the file keeps being followed until it reports the last step done, or a failure.
 */
export async function followRemoval(deps: FollowDeps): Promise<UninstallResult> {
  const pollMs = deps.pollMs ?? 150
  const idleMs = deps.idleMs ?? 60_000
  const now = deps.now ?? Date.now
  let failed = false
  let finished = false
  let current = 0
  let heard = now()

  const forward = (events: SetupEvent[]): void => {
    if (events.length) heard = now()
    for (const e of events) {
      if (failed || finished) return
      if (e.kind === 'failed') {
        failed = true
        deps.onFailed({ step: e.step, message: e.message })
        return
      }
      current = e.step
      if (e.step === LAST_STEP && e.state === 'done') {
        try {
          deps.beforeLastDone()
        } catch (err) {
          failed = true
          deps.onFailed({ step: e.step, message: err instanceof Error ? err.message : String(err) })
          return
        }
        finished = true
      }
      deps.onProgress({ step: e.step, state: e.state })
    }
  }

  const timer = setInterval(() => forward(deps.read()), pollMs)
  let result: ElevatedResult
  try {
    result = await deps.run()
  } finally {
    clearInterval(timer)
  }
  forward(deps.read())

  if (result.code === ERROR_CANCELLED) return 'cancelled'
  if (result.code !== 0) {
    // The helper says what broke itself; this is only for when it could not even start.
    if (!failed) {
      failed = true
      deps.onFailed({ step: current, message: result.stderr || `Удаление завершилось с кодом ${result.code}.` })
    }
    return 'failed'
  }

  heard = now()
  while (!failed && !finished) {
    await wait(pollMs)
    forward(deps.read())
    if (!failed && !finished && now() - heard > idleMs) {
      failed = true
      deps.onFailed({ step: current, message: 'Удаление остановилось на полпути и ничего не сообщает. Перезагрузите компьютер и повторите удаление.' })
    }
  }
  return failed ? 'failed' : 'done'
}
