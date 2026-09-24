import type { UpdateState } from '../../shared/types'

/** A newer version the server offers. */
export interface Found {
  version: string
  notes: string[]
  /** Bytes to download. */
  total: number
}

type Failed = Extract<UpdateState, { kind: 'failed' }>
/** A finished download: `file` is the installer on disk, which the window never needs to know. */
export type Downloaded = Extract<UpdateState, { kind: 'ready' }> & { file?: string }

/**
 * Where an update comes from, in two steps, so that with «Обновлять автоматически» off nothing is
 * downloaded until the user asks. `download` reports its progress and ends `ready` or `failed`.
 */
export interface UpdateSource {
  check(): Promise<Found | null | Failed>
  download(found: Found, report: (received: number) => void): Promise<Downloaded | Failed>
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
  download(): Promise<void>
  install(): Promise<void>
}

/**
 * An install that was called off, not one that failed: the administrator prompt was declined. The card goes
 * back to «готова к установке», with the reason, so it can simply be pressed again.
 */
export class InstallCancelled extends Error {}

const failure = (err: unknown): Failed => ({
  kind: 'failed',
  reason: 'network',
  message: err instanceof Error ? err.message : String(err)
})

/**
 * The state behind the «Обновления» card. One thing at a time: a check while another check, a download
 * or an install is under way — or over an update already found — is ignored rather than starting over.
 */
export function createUpdater(deps: UpdaterDeps): Updater {
  const now = deps.now ?? Date.now
  let state: UpdateState = { kind: 'idle', checkedAt: null }
  let file: string | undefined
  const set = (next: UpdateState): void => {
    state = next
    deps.send(next)
  }
  const fail = (end: Failed): void => {
    set(end)
    deps.log(end.reason === 'network' ? 'warn' : 'info', `Обновления: ${end.message}`)
  }

  const download = async (found: Found): Promise<void> => {
    const { version, notes, total } = found
    set({ kind: 'downloading', version, notes, received: 0, total })
    let end: Downloaded | Failed
    try {
      end = await deps.source.download(found, (received) => set({ kind: 'downloading', version, notes, received, total }))
    } catch (err) {
      end = failure(err)
    }
    if (end.kind === 'failed') return fail(end)
    file = end.file
    set({ kind: 'ready', version: end.version, notes: end.notes })
    deps.log('info', `Обновление ${version} загружено и проверено`)
  }

  return {
    get: () => state,

    async check() {
      if (state.kind !== 'idle' && state.kind !== 'failed') return
      set({ kind: 'checking' })
      let found: Found | null | Failed
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
      if (state.kind !== 'available') return
      const { version, notes, total } = state
      await download({ version, notes, total })
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
        const end = failure(err)
        deps.log('error', `Обновление ${version} не установилось: ${end.message}`)
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
  download: () => Promise.reject(new Error('Для этой системы обновлений нет'))
})

export type SimulatedUpdate = 'available' | 'latest' | 'network' | 'revoked' | 'unsupported'
export const SIMULATED: readonly SimulatedUpdate[] = ['available', 'latest', 'network', 'revoked', 'unsupported']

const FAILED = {
  network: 'Сервер обновлений не ответил. Проверим ещё раз позже — или нажмите «Повторить».',
  revoked: 'Сервер больше не выдаёт обновления для этой копии. Обратитесь к тому, кто дал вам SenAWG.',
  unsupported:
    'Эта копия подписана не нами — возможно, изменена. Чтобы получать обновления, установите SenAWG заново из того источника, откуда вы получили его впервые.'
} as const

/** Made-up answers for working on the card from `npm run dev` (AWG_UPDATE_SIMULATE). */
export const simulated = (scenario: SimulatedUpdate, step = 200): UpdateSource => ({
  async check() {
    await wait(step * 6)
    if (scenario === 'latest') return null
    if (scenario !== 'available') return { kind: 'failed', reason: scenario, message: FAILED[scenario] }
    return { version: '0.6.0', notes: ['Пример: что изменилось в новой версии', 'Пример: ещё одно изменение'], total: 38_400_000 }
  },
  async download(found, report) {
    for (let received = 0; received < found.total; received += 2_400_000) {
      report(received)
      await wait(step)
    }
    return { kind: 'ready', version: found.version, notes: found.notes }
  }
})
