import type { AppState, TunnelState, TunnelStats } from '../../shared/types'
import { AWG_VERSION_LABEL, detectAwgVersion } from '../../shared/awgVersion'
import type { Logger } from '../logger'
import { listTunnels, loadSecrets } from '../store'
import { isHandshakeFresh } from './handshake'
import { describeCapture } from './capture'
import { describeProbe, probeTunnel, type ProbeResult } from './healthCheck'
import { type ActiveTunnel, type TunnelController, UserCancelledError } from './TunnelController'

const POLL_MS = 1000
/** awg.sh captures for 25 s after connecting; read it once it is surely finished. */
const CAPTURE_READY_MS = 28_000

/** The slice of FileTail the manager needs (keeps the manager decoupled from the file system). */
export interface DaemonTail {
  start(from: 'end' | 'recent'): void
  poll(): void
  stop(): void
}

export class TunnelManager {
  private active: ActiveTunnel | null = null
  private states = new Map<string, TunnelState>()
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private switching = false
  private hadHandshake = false
  private needsCleanup = false
  private connectedAt = 0
  /** When the current handshake streak began (epoch ms); 0 while there is no fresh handshake or it is unknown. */
  private upSince = 0
  /**
   * For a tunnel found running at start-up: when it really came up (0 = unknown). Used instead of
   * «now» for its first handshake, so the card does not claim it has just connected.
   */
  private resumedAt: number | null = null
  /** Diagnostics setting as it was when the current connection started. */
  private captureRequested = false

  constructor(
    private readonly controller: TunnelController,
    private readonly emit: (state: AppState) => void,
    private readonly log: Logger,
    private readonly tail: DaemonTail,
    private readonly probe: (stats: () => Promise<TunnelStats>) => Promise<ProbeResult> = probeTunnel,
    private readonly diagnostics: () => boolean = () => false
  ) {}

  snapshot(): AppState {
    const tunnels = listTunnels()
    const states: Record<string, TunnelState> = {}
    for (const t of tunnels) states[t.id] = this.states.get(t.id) ?? { id: t.id, status: 'down' }
    return {
      tunnels,
      states,
      activeId: this.active?.id ?? null,
      busy: this.busy,
      switching: this.switching,
      needsCleanup: this.needsCleanup,
      diagnostics: this.diagnostics()
    }
  }

  /** Reattach to a tunnel that outlived the previous app session. */
  async init(): Promise<void> {
    const found = await this.controller.recover()
    const tunnel = found && listTunnels().find((t) => t.id === found.id)
    if (found && tunnel) {
      this.active = found
      this.resumedAt = found.startedAt ?? 0
      this.set(found.id, { status: 'connecting' })
      this.log.info(`Найден работающий туннель «${tunnel.name}» (${found.iface}) — подключаюсь к нему`)
      this.tail.start('recent')
      this.startPolling()
    } else if (await this.controller.hasStaleState()) {
      this.needsCleanup = true
      this.log.warn(
        'Прошлое подключение завершилось без отключения (перезагрузка или сбой): его DNS и маршрут до сервера ' +
          'могут быть ещё применены. Нажмите «Восстановить сеть»'
      )
    }
    this.push()
  }

  /** Removes a dead session's DNS override and routes. */
  async cleanup(): Promise<void> {
    if (this.busy) throw new Error('Дождитесь завершения текущей операции')
    if (this.active) throw new Error('Туннель активен — отключите его обычным способом')
    this.busy = true
    this.push()
    this.log.info('Восстановление сетевых настроек…')
    try {
      await this.controller.cleanup()
      this.needsCleanup = false
      this.log.info('Сетевые настройки восстановлены')
    } catch (err) {
      if (err instanceof UserCancelledError) this.log.info('Восстановление отменено пользователем')
      else this.log.error(`Не удалось восстановить сеть: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.busy = false
      this.push()
    }
  }

  /** Connects, or switches to `id` when another tunnel is running (one admin prompt, see awg.sh --replace). */
  async connect(id: string): Promise<void> {
    if (this.busy) throw new Error('Дождитесь завершения текущей операции')
    if (this.active?.id === id) return
    const tunnel = listTunnels().find((t) => t.id === id)
    if (!tunnel) throw new Error('Туннель не найден')
    const secrets = loadSecrets(id)
    if (!secrets) throw new Error('Ключи туннеля не найдены в хранилище — импортируйте ссылку заново')

    const previous = this.active
    const previousState = previous ? this.states.get(previous.id) : undefined
    const label = `«${tunnel.name}» (${tunnel.endpoint}, ${AWG_VERSION_LABEL[detectAwgVersion(tunnel.awg)]})`
    this.busy = true
    this.switching = previous !== null
    if (previous) {
      // The old tunnel stops inside the same privileged call; stop watching it now.
      this.stopPolling()
      this.finishTail()
      this.active = null
      this.set(previous.id, { status: 'down' })
      this.log.info(`Переключение на ${label}…`)
    } else {
      this.log.info(`Подключение к ${label}…`)
    }
    this.hadHandshake = false
    this.upSince = 0
    this.resumedAt = null
    this.set(id, { status: 'connecting' })
    this.push()
    this.tail.start('end') // before up(): the daemon starts writing while the script is still running
    try {
      this.connectedAt = Date.now()
      this.captureRequested = this.diagnostics()
      this.active = await this.controller.up(tunnel, secrets, previous !== null)
      this.log.info(`Интерфейс ${this.active.iface} поднят, жду рукопожатия`)
      this.startPolling()
    } catch (err) {
      this.finishTail()
      if (err instanceof UserCancelledError) {
        this.log.info(previous ? 'Переключение отменено пользователем' : 'Подключение отменено пользователем')
        this.set(id, { status: 'down' })
      } else {
        const message = err instanceof Error ? err.message : String(err)
        this.log.error(`Не удалось подключиться: ${message}`)
        this.set(id, { status: 'error', error: message })
      }
      if (previous) await this.keepPrevious(previous, previousState)
    } finally {
      // awg.sh up removes a dead session's leftovers before starting; re-check what remains.
      this.needsCleanup = this.active ? false : await this.controller.hasStaleState().catch(() => this.needsCleanup)
      this.busy = false
      this.switching = false
      this.push()
    }
  }

  /**
   * A failed switch may or may not have stopped the old tunnel (a cancelled prompt or a bad config
   * fails before it is touched). Ask the system which one it is rather than guess.
   */
  private async keepPrevious(previous: ActiveTunnel, state: TunnelState | undefined): Promise<void> {
    const running = await this.controller.recover().catch(() => null)
    if (running?.id !== previous.id) {
      this.log.warn('Прежний туннель остановлен — VPN выключен')
      return
    }
    this.active = { ...previous, ...running }
    this.set(previous.id, state ? { status: state.status, stats: state.stats, since: state.since } : { status: 'connecting' })
    this.hadHandshake = state?.status === 'up'
    this.upSince = state?.since ?? 0
    this.captureRequested = false
    this.log.info('Прежний туннель продолжает работать')
    this.tail.start('end')
    this.startPolling()
  }

  async disconnect(id: string): Promise<void> {
    if (this.busy) throw new Error('Дождитесь завершения текущей операции')
    if (!this.active || this.active.id !== id) return
    this.busy = true
    const active = this.active
    this.push()
    this.log.info('Отключение…')
    try {
      await this.controller.down(active)
      this.stopPolling()
      this.finishTail() // one last read: the daemon's shutdown lines
      this.active = null
      this.set(id, { status: 'down' })
      this.log.info('Туннель остановлен')
    } catch (err) {
      // Cancelled or failed: the tunnel is still up, so keep reporting it.
      if (err instanceof UserCancelledError) {
        this.log.info('Отключение отменено пользователем')
      } else {
        const message = err instanceof Error ? err.message : String(err)
        this.log.error(`Не удалось отключить: ${message}`)
        this.set(id, { ...this.states.get(id)!, error: message })
      }
    } finally {
      this.busy = false
      this.push()
    }
  }

  isActive(id: string): boolean {
    return this.active?.id === id
  }

  forget(id: string): void {
    this.states.delete(id)
    this.push()
  }

  dispose(): void {
    this.stopPolling()
    this.tail.stop()
  }

  private set(id: string, patch: Omit<TunnelState, 'id'>): void {
    this.states.set(id, { id, ...patch })
  }

  private push(): void {
    this.emit(this.snapshot())
  }

  private finishTail(): void {
    this.tail.poll()
    this.tail.stop()
  }

  /** One unprivileged end-to-end probe per connection; results only go to the journal. */
  private async checkConnectivity(active: ActiveTunnel): Promise<void> {
    try {
      const result = await this.probe(() => this.controller.stats(active))
      if (this.active?.id !== active.id) return // disconnected meanwhile
      for (const line of describeProbe(result, active.iface)) this.log.add(line.level, 'app', line.message)
    } catch (err) {
      this.log.warn(`Проверка связи не выполнена: ${err instanceof Error ? err.message : String(err)}`)
    }
    await this.reportCapture(active)
  }

  private async reportCapture(active: ActiveTunnel): Promise<void> {
    if (!this.captureRequested || !this.controller.readCapture || !active.endpointIp) return
    const wait = this.connectedAt + CAPTURE_READY_MS - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    const capture = await this.controller.readCapture()
    if (!capture) return this.log.warn('Захват пакетов недоступен')
    for (const line of describeCapture(capture.inner, capture.outer, active.endpointIp, active.iface, active.localIp, capture.innerVerbose)) {
      this.log.add(line.level, 'app', line.message)
    }
  }

  private startPolling(): void {
    this.stopPolling()
    void this.poll()
    this.timer = setInterval(() => void this.poll(), POLL_MS)
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async poll(): Promise<void> {
    const active = this.active
    if (!active || this.busy) return
    try {
      const stats = await this.controller.stats(active)
      const fresh = isHandshakeFresh(stats)
      if (fresh && !this.hadHandshake) {
        this.upSince = this.resumedAt ?? Date.now()
        this.resumedAt = null
        this.log.info('Рукопожатие выполнено, проверяю связь…')
        void this.checkConnectivity(active)
      }
      if (!fresh && this.hadHandshake) this.log.warn('Рукопожатие устарело — сервер не отвечает')
      if (!fresh) this.upSince = 0
      this.hadHandshake = fresh
      this.set(active.id, { status: fresh ? 'up' : 'connecting', stats, ...(fresh && this.upSince ? { since: this.upSince } : {}) })
    } catch {
      // Socket gone: the daemon died underneath us.
      this.stopPolling()
      this.finishTail()
      this.active = null
      this.log.error('Туннель остановился неожиданно (сокет amneziawg-go закрыт)')
      this.set(active.id, { status: 'error', error: 'Туннель остановился неожиданно' })
    }
    this.push()
  }
}
