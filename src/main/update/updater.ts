import type { ErrorCode } from '../../shared/errorCatalog'
import type { UpdateState } from '../../shared/types'
import { AppError, asAppError, failureLine } from '../appError'

/** A newer version the server offers. */
export interface Found {
  version: string
  notes: string[]
  /** Bytes to download. */
  total: number
}

type Failed = Extract<UpdateState, { kind: 'failed' }>
/**
 * A finished download: `file` is the installer on disk — or, put together from the changed files
 * (files.ts), the folder of the new version itself. The window never needs to know either.
 */
export type Downloaded = Extract<UpdateState, { kind: 'ready' }> & { file?: string }

/**
 * Where an update comes from, in two steps, so that with «Обновлять автоматически» off nothing is
 * downloaded until the user asks. `download` reports its progress and ends `ready` or `failed`.
 */
export interface UpdateSource {
  check(): Promise<Found | null | Failed>
  /**
   * `report`'s `total`: how much this download actually is, when it is not the installer's size — the
   * changed files alone (files.ts). `signal` pauses it: what came so far is kept, and the next download
   * of the same version goes on from there.
   */
  download(found: Found, report: (received: number, total?: number) => void, signal?: AbortSignal): Promise<Downloaded | Failed>
}

export interface UpdaterDeps {
  source: UpdateSource
  /** «Обновлять автоматически»: whether a found version downloads by itself. */
  automatic(): boolean
  /** Every change goes to the window as it happens. */
  send(state: UpdateState): void
  /**
   * Closes the application into the installer's update screen, so it does not come back; only the
   * simulation returns. Only ever called from `ready`, with the file that download left.
   */
  install(version: string, file: string | undefined): Promise<void>
  log(level: 'info' | 'warn' | 'error', message: string): void
  now?(): number
}

export interface Updater {
  get(): UpdateState
  check(): Promise<void>
  /** Fetches what was found, or goes on with a paused download from where it stopped. */
  download(): Promise<void>
  /** Stops the download where it is; `download` goes on from there. */
  pause(): void
  install(): Promise<void>
}

/**
 * An install that was called off, not one that failed: the administrator prompt was declined. The card goes
 * back to «готова к установке», with the reason, so it can simply be pressed again.
 */
export class InstallCancelled extends AppError {}

/**
 * A failure for the card in the catalog's words — `fallback` when it has none — and its journal line, with the
 * details. A source's own verdict (revoked, unsupported) comes without one: its message is the line.
 */
type Failure = Failed & { line?: string }
const failure = (err: unknown, fallback: ErrorCode = 'UPD-01'): Failure & { line: string } => {
  const e = asAppError(err, fallback)
  return { kind: 'failed', reason: 'network', message: e.message, line: failureLine(e) }
}

/**
 * The state behind the «Обновления» card. One thing at a time: a check while another check, a download
 * or an install is under way — or over an update already found — is ignored rather than starting over.
 */
export function createUpdater(deps: UpdaterDeps): Updater {
  const now = deps.now ?? Date.now
  let state: UpdateState = { kind: 'idle', checkedAt: null }
  let file: string | undefined
  // The download under way, which pause() stops; and what it is of — a paused one goes on with the installer's own
  // size, not the changed files' the card shows.
  let running: { stop: AbortController; done: Promise<void> } | null = null
  let fetching: Found | null = null
  const set = (next: UpdateState): void => {
    state = next
    deps.send(next)
  }
  const fail = ({ line, ...end }: Failure): void => {
    set(end)
    deps.log(end.reason === 'network' ? 'warn' : 'info', line ?? end.message)
  }

  const download = async (found: Found, from = 0, shown = found.total): Promise<void> => {
    const { version, notes, total } = found
    set({ kind: 'downloading', version, notes, received: from, total: shown })
    // A paused download may still be letting go of its file, and this one writes the same: one at a time.
    await running?.done
    if (state.kind !== 'downloading') return
    fetching = found
    const stop = new AbortController()
    let finish = (): void => {}
    running = { stop, done: new Promise((resolve) => (finish = resolve)) }
    let end: Downloaded | Failure
    try {
      end = await deps.source.download(
        found,
        (received, size = total) => {
          if (!stop.signal.aborted) set({ kind: 'downloading', version, notes, received, total: size })
        },
        stop.signal
      )
    } catch (err) {
      // Paused: pause() has said so already.
      if (stop.signal.aborted) return
      end = failure(err)
    } finally {
      running = null
      finish()
    }
    // Paused just as it ended: it is here all the same.
    if (end.kind === 'failed') return stop.signal.aborted ? undefined : fail(end)
    file = end.file
    set({ kind: 'ready', version: end.version, notes: end.notes })
    deps.log('info', `Обновление ${version} загружено и проверено`)
  }

  return {
    get: () => state,

    async check() {
      if (state.kind !== 'idle' && state.kind !== 'failed') return
      set({ kind: 'checking' })
      let found: Found | null | Failure
      try {
        found = await deps.source.check()
      } catch (err) {
        found = failure(err)
      }
      if (found === null) return set({ kind: 'idle', checkedAt: now() })
      if ('kind' in found) return fail(found)
      if (deps.automatic()) return download(found)
      set({ kind: 'available', ...found })
      deps.log('info', `Доступно обновление ${found.version}`)
    },

    async download() {
      if (state.kind === 'available') {
        const { version, notes, total } = state
        return download({ version, notes, total })
      }
      if (state.kind !== 'paused') return
      const { version, notes, received, total } = state
      await download(fetching?.version === version ? fetching : { version, notes, total }, received, total)
    },

    pause() {
      if (state.kind !== 'downloading') return
      const { version, notes, received, total } = state
      set({ kind: 'paused', version, notes, received, total })
      deps.log('info', `Загрузка обновления ${version} приостановлена`)
      running?.stop.abort()
    },

    async install() {
      if (state.kind !== 'ready') return
      const { version, notes } = state
      set({ kind: 'installing', version })
      deps.log('info', `Установка обновления ${version}`)
      try {
        await deps.install(version, file)
        set({ kind: 'idle', checkedAt: now() })
      } catch (err) {
        if (err instanceof InstallCancelled) {
          deps.log('info', `Обновление ${version} не установлено: ${err.message}`)
          return set({ kind: 'ready', version, notes, message: err.message })
        }
        const { line, ...end } = { ...failure(err, 'UPD-22'), installing: true }
        deps.log('error', line)
        set(end)
      }
    }
  }
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Where the site offers nothing for this platform (macOS): never anything newer, «Обновлений нет». */
export const noServer = (delay = 800): UpdateSource => ({
  async check() {
    await wait(delay)
    return null
  },
  download: () => Promise.reject(new AppError('UPD-17', undefined, 'для этой системы обновлений нет'))
})

export type SimulatedUpdate = 'available' | 'latest' | 'network' | 'revoked' | 'unsupported'
export const SIMULATED: readonly SimulatedUpdate[] = ['available', 'latest', 'network', 'revoked', 'unsupported']

const FAILED = {
  network: 'Сервер обновлений не ответил. Проверим ещё раз позже — или нажмите «Повторить».',
  revoked: 'Сервер больше не выдаёт обновления для этой копии. Обратитесь к тому, кто дал вам SenAWG.',
  unsupported:
    'Эта копия подписана не нами — возможно, изменена. Чтобы получать обновления, установите SenAWG заново из того источника, откуда вы получили его впервые.'
} as const

/** Made-up answers for working on the card from `npm run dev` (AWG_UPDATE_SIMULATE). A paused download goes on from where it stopped. */
export const simulated = (scenario: SimulatedUpdate, step = 200): UpdateSource => {
  let got = 0
  return {
    async check() {
      await wait(step * 6)
      if (scenario === 'latest') return null
      if (scenario !== 'available') return { kind: 'failed', reason: scenario, message: FAILED[scenario] }
      return { version: '0.6.0', notes: ['Пример: что изменилось в новой версии', 'Пример: ещё одно изменение'], total: 38_400_000 }
    },
    async download(found, report, signal) {
      for (; got < found.total; got += 2_400_000) {
        report(got)
        await wait(step)
        signal?.throwIfAborted()
      }
      got = 0
      return { kind: 'ready', version: found.version, notes: found.notes }
    }
  }
}
