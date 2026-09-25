import type { AppState, SubscriptionView, TunnelState, TunnelStats } from '../../shared/types'
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
/** How often the privileged watcher of the tunnel is looked for (it is a `ps` call). */
const WATCHDOG_CHECK_MS = 30_000
/**
 * The route to the server is gone: macOS refuses every send (EADDRNOTAVAIL), Linux reports no route at
 * all (ENETUNREACH). It happens for a moment on every network change, until the route comes back.
 */
const ROUTE_LOST = /can't assign requested address|network is unreachable/
/** Only the server can have sent these: packets arrive again. */
const PEER_HEARD = /Received handshake response|Receiving keepalive packet/
/** Still failing this long after it began: the route is not coming back by itself. */
const ROUTE_LOST_AFTER_MS = 10_000
/** No failed send for this long: whatever it was is over. */
const ROUTE_QUIET_MS = 60_000

export const ROUTE_LOST_MESSAGE =
  'Связь с сервером потеряна после смены сети: система не может отправить пакеты по старому маршруту. Переподключитесь'
export const WATCHDOG_DEAD_MESSAGE =
  'Фоновый процесс туннеля не работает: после смены сети или выхода из сна связь не восстановится сама, ' +
  'а туннель не отключится при закрытии приложения. Переподключитесь'

/** The slice of FileTail the manager needs (keeps the manager decoupled from the file system). */
export interface DaemonTail {
  start(from: 'end' | 'recent'): void
  poll(): void
  stop(): void
}

/** What a master key (sen://) needs to know about a tunnel's life; none of it applies to a vpn:// key. */
export interface TunnelHooks {
  /** Before a connect is made: a chance to fetch the newest settings. Its errors never stop the connect. */
  beforeConnect?(id: string): Promise<void>
  /** The handshake of `id` went stale, or never came within STALE_FIRST_MS of connecting. Once per connection. */
  onStale?(id: string): Promise<void>
  subscriptions?(): SubscriptionView[]
}

/** No handshake this long after connecting: parameters changed on the server while we were away. */
const STALE_FIRST_MS = 30_000

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
  /** First and latest failed send of the current run of them (epoch ms); 0 when there is none. */
  private routeLostSince = 0
  private routeLostLast = 0
  private routeLost = false
  private watchdogDead = false
  private watchdogCheckedAt = 0
  /** onStale already fired for the current connection. */
  private staleNotified = false

  constructor(
    private readonly controller: TunnelController,
    private readonly emit: (state: AppState) => void,
    private readonly log: Logger,
    private readonly tail: DaemonTail,
    private readonly probe: (stats: () => Promise<TunnelStats>) => Promise<ProbeResult> = probeTunnel,
    private readonly diagnostics: () => boolean = () => false,
    private readonly hooks: TunnelHooks = {}
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
      degraded: this.active ? (this.routeLost ? ROUTE_LOST_MESSAGE : this.watchdogDead ? WATCHDOG_DEAD_MESSAGE : null) : null,
      diagnostics: this.diagnostics(),
      subscriptions: this.hooks.subscriptions?.() ?? []
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
      this.resetHealth()
      await this.checkWatchdog()
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
    await this.start(id)
  }

  /** Brings the running tunnel up again from scratch: new route, new monitor. One admin prompt, like a switch. */
  async reconnect(): Promise<void> {
    if (this.busy) throw new Error('Дождитесь завершения текущей операции')
    if (!this.active) throw new Error('Туннель не подключён')
    await this.start(this.active.id)
  }

  private async start(id: string): Promise<void> {
    if (!listTunnels().some((t) => t.id === id)) throw new Error('Туннель не найден')
    // Only awaited when there is a hook: without one a connect must start on the very call.
    if (this.hooks.beforeConnect) await this.beforeConnect(id)
    // Re-read: the hook may have brought newer settings.
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
      this.log.info(previous.id === id ? `Переподключение к ${label}…` : `Переключение на ${label}…`)
    } else {
      this.log.info(`Подключение к ${label}…`)
    }
    this.hadHandshake = false
    this.staleNotified = false
    this.upSince = 0
    this.resumedAt = null
    this.resetHealth()
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

  private async beforeConnect(id: string): Promise<void> {
    if (!this.hooks.beforeConnect) return
    this.busy = true
    this.push()
    try {
      await this.hooks.beforeConnect(id)
    } catch (err) {
      this.log.warn(`Не удалось обновить настройки перед подключением: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.busy = false
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
    this.resetHealth()
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

  /** The removal screen is up: nothing may talk to the service any more (it would start it again). */
  pause(): void {
    this.dispose()
  }

  /** Back from a removal that was declined or failed: if the tunnel did not survive it, polling finds out. */
  resume(): void {
    if (!this.active) return
    this.tail.start('recent')
    this.startPolling()
  }

  /** New lines of the daemon's log: watches for the route to the server going away and coming back. */
  daemonLines(lines: string[], now = Date.now()): void {
    if (!this.active) return
    for (const line of lines) {
      if (ROUTE_LOST.test(line)) {
        if (!this.routeLostSince) this.routeLostSince = now
        this.routeLostLast = now
      } else if (PEER_HEARD.test(line)) {
        this.clearRouteLost()
      }
    }
  }

  private clearRouteLost(): void {
    if (this.routeLost) this.log.info('Связь с сервером восстановлена')
    this.routeLostSince = 0
    this.routeLostLast = 0
    this.routeLost = false
  }

  private resetHealth(): void {
    this.routeLostSince = 0
    this.routeLostLast = 0
    this.routeLost = false
    this.watchdogDead = false
    this.watchdogCheckedAt = 0
  }

  /** A brief failure is every network change; one that goes on means the route was never rebuilt. */
  private checkRoute(now: number): void {
    if (!this.routeLostSince) return
    if (now - this.routeLostLast > ROUTE_QUIET_MS) {
      this.clearRouteLost()
    } else if (!this.routeLost && this.routeLostLast - this.routeLostSince >= ROUTE_LOST_AFTER_MS) {
      this.routeLost = true
      this.log.warn(ROUTE_LOST_MESSAGE)
    }
  }

  private async checkWatchdog(now = Date.now()): Promise<void> {
    if (!this.controller.watchdogAlive || now - this.watchdogCheckedAt < WATCHDOG_CHECK_MS) return
    this.watchdogCheckedAt = now
    const alive = await this.controller.watchdogAlive().catch(() => true)
    if (!alive && !this.watchdogDead) this.log.warn(WATCHDOG_DEAD_MESSAGE)
    this.watchdogDead = !alive
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

  /** Once per connection, when the tunnel lost its handshake or has waited too long for the first. */
  private notifyStale(id: string, hadHandshake: boolean): void {
    if (this.staleNotified || !this.hooks.onStale) return
    if (!hadHandshake && Date.now() - this.connectedAt < STALE_FIRST_MS) return
    this.staleNotified = true
    void this.hooks.onStale(id).catch((err: unknown) => {
      this.log.warn(`Не удалось обновить настройки: ${err instanceof Error ? err.message : String(err)}`)
    })
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
      if (fresh) this.staleNotified = false
      else this.notifyStale(active.id, this.hadHandshake)
      if (!fresh) this.upSince = 0
      this.hadHandshake = fresh
      this.set(active.id, { status: fresh ? 'up' : 'connecting', stats, ...(fresh && this.upSince ? { since: this.upSince } : {}) })
      this.checkRoute(Date.now())
      await this.checkWatchdog()
      if (this.active !== active) return // disconnected or switched meanwhile
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
