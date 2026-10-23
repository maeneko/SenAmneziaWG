import type { AppState, SubscriptionView, Tunnel, TunnelState, TunnelStats } from '../../shared/types'
import { AWG_VERSION_LABEL, detectAwgVersion } from '../../shared/awgVersion'
import type { RoutingConfig } from '../../shared/routingRules'
import { AppError, asAppError, failureLine } from '../appError'
import type { Logger } from '../logger'
import type { TunnelSecrets } from '../config/wgConfig'
import { listTunnels, loadSecrets } from '../store'
import { isHandshakeFresh } from './handshake'
import { describeCapture } from './capture'
import { describeProbe, probeTunnel, type ProbeResult } from './healthCheck'
import { type ActiveTunnel, type TunnelController, UserCancelledError } from './TunnelController'

const POLL_MS = 1000
/** Default for how often a live tunnel is probed end to end again (the first probe is made at the handshake). */
const RECHECK_MS = 60_000
/** Consecutive failed probes before the card says the tunnel carries nothing: one timeout is just a bad second. */
const RECHECK_FAILS = 2
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
/** Pause before each automatic reconnect of one run of trouble; past the last, the card asks the user. */
const AUTO_RECONNECT_MS = [2_000, 10_000, 30_000]
/** Healthy this long: that trouble is over, and the next one gets all its attempts again. */
const AUTO_RESET_MS = 120_000
/** After the computer wakes, how long the handshake has to come back by itself. */
const WAKE_GRACE_MS = 20_000

export const ROUTE_LOST_MESSAGE =
  'Связь с сервером потеряна после смены сети: система не может отправить пакеты по старому маршруту. Переподключитесь'
export const NO_TRAFFIC_MESSAGE =
  'Рукопожатие есть, но через туннель ничего не проходит: проверка связи не удалась несколько раз подряд. Переподключитесь'
export const FAILED_CLOSED_MESSAGE =
  'Чтобы трафик не пошёл мимо VPN, всё, что шло через туннель, заблокировано (локальная сеть работает). ' +
  'Переподключитесь или нажмите «Восстановить сеть»'
export const WATCHDOG_DEAD_MESSAGE =
  'Фоновый процесс туннеля не работает: после смены сети или выхода из сна связь не восстановится сама, ' +
  'а туннель не отключится при закрытии приложения. Переподключитесь'
export const AUTO_GAVE_UP_MESSAGE = 'Переподключиться само не получилось — переподключитесь вручную'

/** The slice of FileTail the manager needs (keeps the manager decoupled from the file system). */
export interface DaemonTail {
  start(from: 'end' | 'recent'): void
  poll(): void
  stop(): void
}

/** What a master key (sen://) needs to know about a tunnel's life; none of it applies to a vpn:// key. */
export interface TunnelHooks {
  /**
   * Before a connect is made: a chance to fetch the newest settings. Its errors never stop the connect, but a catalog
   * error (AppError): that is the hook refusing it, as for a master key whose server has been silent too long.
   */
  beforeConnect?(id: string): Promise<void>
  /** The handshake of `id` went stale, or never came within STALE_FIRST_MS of connecting. Once per connection. */
  onStale?(id: string): Promise<void>
  subscriptions?(): SubscriptionView[]
  accounts?(): string[]
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
  /** Periodic probe of a live tunnel: when it last started (0 = none yet), whether one runs, failures in a row. */
  private recheckedAt = 0
  private rechecking = false
  private recheckFails = 0
  /** onStale already fired for the current connection. */
  private staleNotified = false
  /**
   * Automatic reconnects of the current run of trouble, when the next one is due (0 = not yet planned), when the
   * tunnel was last seen healthy since (0 = it is not), and whether the journal was told they ran out.
   */
  private autoTries = 0
  private autoDueAt = 0
  private healthySince = 0
  private autoGaveUp = false
  /** When the computer woke while connected; 0 once the handshake is back. */
  private wokeAt = 0

  constructor(
    private readonly controller: TunnelController,
    private readonly emit: (state: AppState) => void,
    private readonly log: Logger,
    private readonly tail: DaemonTail,
    private readonly probe: (stats: () => Promise<TunnelStats>) => Promise<ProbeResult> = probeTunnel,
    private readonly diagnostics: () => boolean = () => false,
    private readonly hooks: TunnelHooks = {},
    /** The user's interval between probes of a live tunnel, ms; 0 = never again. */
    private readonly recheckMs: () => number = () => RECHECK_MS,
    /** «Маршрутизация» in Settings: the probe reads its verdict differently with rules. */
    private readonly routing: () => RoutingConfig | null = () => null,
    /** Whether the system has a network at all: a reconnect without one fails and leaves the VPN off. */
    private readonly online: () => boolean = () => true
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
      degraded: this.active ? (this.routeLost ? ROUTE_LOST_MESSAGE : this.recheckFails >= RECHECK_FAILS ? NO_TRAFFIC_MESSAGE : this.watchdogDead ? WATCHDOG_DEAD_MESSAGE : null) : null,
      diagnostics: this.diagnostics(),
      subscriptions: this.hooks.subscriptions?.() ?? [],
      accounts: this.hooks.accounts?.() ?? []
    }
  }

  /**
   * Reattach to a tunnel that outlived the previous app session. `cleanup`: a dead session's leftovers are taken
   * down at once, without asking — but not when a connect follows, which removes them itself and keeps the traffic
   * held meanwhile.
   */
  async init(opts: { cleanup?: boolean } = {}): Promise<void> {
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
      if (opts.cleanup && !this.controller.asksEachTime) {
        this.log.warn('Прошлое подключение завершилось без отключения (перезагрузка или сбой) — восстанавливаю сетевые настройки')
        return this.cleanup()
      }
      this.log.warn(
        'Прошлое подключение завершилось без отключения (перезагрузка или сбой): его DNS и маршрут до сервера ' +
          'могут быть ещё применены. Нажмите «Восстановить сеть»'
      )
    }
    this.push()
  }

  /** Removes a dead session's DNS override and routes. */
  async cleanup(): Promise<void> {
    if (this.busy) throw new AppError('TUN-04')
    if (this.active) throw new AppError('TUN-05')
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
    if (this.busy) throw new AppError('TUN-04')
    if (this.active?.id === id) return
    this.resetAuto()
    await this.start(id)
  }

  /** Brings the running tunnel up again from scratch: new route, new monitor. One admin prompt, like a switch. */
  async reconnect(): Promise<void> {
    if (this.busy) throw new AppError('TUN-04')
    if (!this.active) throw new AppError('TUN-06')
    this.resetAuto()
    await this.start(this.active.id)
  }

  /** The computer woke up: if the handshake does not come back by itself, the tunnel is brought up again. */
  woke(now = Date.now()): void {
    if (this.active) this.wokeAt = now
  }

  private async start(id: string): Promise<void> {
    if (!listTunnels().some((t) => t.id === id)) throw new AppError('TUN-01')
    // Only awaited when there is a hook: without one a connect must start on the very call.
    if (this.hooks.beforeConnect && !(await this.beforeConnect(id))) return
    // Re-read: the hook may have brought newer settings.
    const tunnel = listTunnels().find((t) => t.id === id)
    // Gone while the settings were fetched: its master key no longer has this server, or was revoked.
    if (!tunnel) throw new AppError('KEY-20')
    const secrets = loadSecrets(id)
    if (!secrets) throw new AppError('TUN-02')

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
      this.active = await this.bringUp(tunnel, secrets, previous !== null)
      this.log.info(`Интерфейс ${this.active.iface} поднят, жду рукопожатия`)
      this.startPolling()
    } catch (err) {
      this.finishTail()
      if (err instanceof UserCancelledError) {
        this.log.info(previous ? 'Переключение отменено пользователем' : 'Подключение отменено пользователем')
        this.set(id, { status: 'down' })
      } else {
        // What is not in the catalog yet reads as «VPN не включился», its own words in the journal.
        const failed = asAppError(err, 'TUN-07')
        this.log.error(failureLine(failed))
        this.set(id, { status: 'error', error: failed.message })
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

  /** Up once more when the system did not name the interface (TUN-10): what the card would ask for. */
  private async bringUp(tunnel: Tunnel, secrets: TunnelSecrets, replace: boolean): Promise<ActiveTunnel> {
    try {
      return await this.controller.up(tunnel, secrets, replace)
    } catch (err) {
      if (!(err instanceof AppError) || err.errorCode !== 'TUN-10' || this.controller.asksEachTime) throw err
      this.log.warn(`${failureLine(err)} — пробую ещё раз`)
      // Whatever the first attempt left running is stopped by the second.
      return await this.controller.up(tunnel, secrets, true)
    }
  }

  /** false: the hook refused the connect, and the card says why. */
  private async beforeConnect(id: string): Promise<boolean> {
    if (!this.hooks.beforeConnect) return true
    this.busy = true
    this.push()
    let refused: AppError | null = null
    try {
      await this.hooks.beforeConnect(id)
    } catch (err) {
      if (err instanceof AppError) refused = err
      else this.log.warn(`Не удалось обновить настройки перед подключением: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.busy = false
    }
    if (!refused) return true
    this.log.error(failureLine(refused))
    // A reconnect of the running one is refused as much as a new connect.
    if (this.active?.id === id) await this.disconnect(id)
    this.set(id, { status: 'error', error: refused.message })
    this.push()
    return false
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
    if (this.busy) throw new AppError('TUN-04')
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
        const failed = asAppError(err)
        this.log.error(failureLine(failed))
        this.set(id, { ...this.states.get(id)!, error: failed.message })
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
    this.recheckedAt = 0
    this.recheckFails = 0
    this.autoDueAt = 0
    this.healthySince = 0
    this.wokeAt = 0
  }

  private resetAuto(): void {
    this.autoTries = 0
    this.autoGaveUp = false
  }

  /** What the card would ask the user to fix by reconnecting; null when there is nothing of the kind. */
  private trouble(now: number): string | null {
    if (this.routeLost) return 'связь с сервером потеряна после смены сети'
    if (this.watchdogDead) return 'фоновый процесс туннеля не работает'
    if (this.wokeAt && now - this.wokeAt >= WAKE_GRACE_MS) return 'после выхода из сна нет рукопожатия'
    return null
  }

  /**
   * Nothing is done behind the user's back where every privileged call asks for the password, and nothing without
   * a network: the reconnect would fail, and the VPN be left off.
   */
  private canHeal(): boolean {
    return !this.controller.asksEachTime && this.online() && this.autoTries < AUTO_RECONNECT_MS.length
  }

  /** The reconnect the card asks for, made here: a few times, with growing pauses, while the trouble lasts. */
  private heal(fresh: boolean, now: number): void {
    if (fresh) this.wokeAt = 0
    const reason = this.trouble(now)
    if (!reason) {
      this.autoDueAt = 0
      if (!fresh) this.healthySince = 0
      else if (!this.healthySince) this.healthySince = now
      else if (now - this.healthySince >= AUTO_RESET_MS) this.resetAuto()
      return
    }
    this.healthySince = 0
    if (this.autoTries >= AUTO_RECONNECT_MS.length) {
      if (!this.autoGaveUp) this.log.warn(AUTO_GAVE_UP_MESSAGE)
      this.autoGaveUp = true
      return
    }
    if (!this.canHeal()) return
    if (!this.autoDueAt) this.autoDueAt = now + AUTO_RECONNECT_MS[this.autoTries]
    else if (now >= this.autoDueAt) void this.autoReconnect(reason)
  }

  private async autoReconnect(reason: string): Promise<void> {
    const active = this.active
    if (!active || this.busy) return
    this.autoTries++
    this.log.info(`Переподключаюсь сам (попытка ${this.autoTries} из ${AUTO_RECONNECT_MS.length}): ${reason}`)
    try {
      await this.start(active.id)
    } catch (err) {
      this.log.error(failureLine(err))
    }
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
      for (const line of describeProbe(result, active.iface, undefined, this.routing())) this.log.add(line.level, 'app', line.message)
    } catch (err) {
      this.log.warn(`Проверка связи не выполнена: ${err instanceof Error ? err.message : String(err)}`)
    }
    await this.reportCapture(active)
  }

  /** While the handshake is fresh, probes again every RECHECK_MS; only a change of verdict reaches the journal. */
  private recheckConnectivity(active: ActiveTunnel, now: number): void {
    const every = this.recheckMs()
    if (!every || this.rechecking || now - this.recheckedAt < every) return
    this.recheckedAt = now
    this.rechecking = true
    void this.probe(() => this.controller.stats(active))
      .then((result) => {
        if (this.active?.id !== active.id) return
        const wasDown = this.recheckFails >= RECHECK_FAILS
        this.recheckFails = result.tcp === 'ok' ? 0 : this.recheckFails + 1
        if (this.recheckFails === RECHECK_FAILS) this.log.warn(NO_TRAFFIC_MESSAGE)
        else if (wasDown && !this.recheckFails) this.log.info('Через туннель снова всё проходит')
      })
      .catch(() => {
        /* a probe that could not run says nothing about the tunnel */
      })
      .finally(() => {
        this.rechecking = false
      })
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
        this.recheckedAt = Date.now()
        void this.checkConnectivity(active)
      }
      if (!fresh && this.hadHandshake) this.log.warn('Рукопожатие устарело — сервер не отвечает')
      if (fresh) this.staleNotified = false
      else this.notifyStale(active.id, this.hadHandshake)
      if (!fresh) this.upSince = 0
      this.hadHandshake = fresh
      this.set(active.id, { status: fresh ? 'up' : 'connecting', stats, ...(fresh && this.upSince ? { since: this.upSince } : {}) })
      this.checkRoute(Date.now())
      if (fresh) this.recheckConnectivity(active, Date.now())
      await this.checkWatchdog()
      if (this.active !== active) return // disconnected or switched meanwhile
      this.heal(fresh, Date.now())
    } catch (err) {
      // Disconnected, switched or reconnected while asked: this was about a tunnel that is gone.
      if (this.active !== active) return
      // No answer, but the socket is there: the daemon hangs rather than died. Bringing it up again is what the
      // card would ask for.
      if (err instanceof AppError && err.errorCode === 'TUN-09' && this.canHeal()) {
        this.log.warn(failureLine(err))
        return this.autoReconnect('VPN не отвечает')
      }
      // Socket gone: the daemon died underneath us.
      this.stopPolling()
      this.finishTail()
      this.active = null
      this.log.error('Туннель остановился неожиданно (сокет amneziawg-go закрыт)')
      if (this.controller.failsClosed) this.log.warn(FAILED_CLOSED_MESSAGE)
      this.set(active.id, { status: 'error', error: 'Туннель остановился неожиданно' })
      // Its routes, DNS and block are still applied: «Восстановить сеть» takes them down.
      this.needsCleanup = await this.controller.hasStaleState().catch(() => true)
    }
    this.push()
  }
}
