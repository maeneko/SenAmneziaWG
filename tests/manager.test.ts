import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState, Tunnel } from '../src/shared/types'

const tunnel = { id: 't1', name: 'Германия', endpoint: '130.17.24.128:47619', awg: { jc: 0, jmin: 0, jmax: 0, s1: 0, s2: 0, h1: '1', h2: '2', h3: '3', h4: '4', extra: {} } } as unknown as Tunnel
const tunnel2 = { ...tunnel, id: 't2', name: 'Финляндия', endpoint: '2.27.175.125:47619' } as Tunnel
vi.mock('../src/main/store', () => ({
  listTunnels: () => [tunnel, tunnel2],
  loadSecrets: () => ({ privateKey: 'k' })
}))
const { TunnelManager } = await import('../src/main/tunnel/manager')
const { Logger } = await import('../src/main/logger')
const { UserCancelledError } = await import('../src/main/tunnel/TunnelController')
const { AppError } = await import('../src/main/appError')

const tail = { start: vi.fn(), poll: vi.fn(), stop: vi.fn() }
function setup(over: Record<string, unknown> = {}) {
  const controller = {
    up: vi.fn(async (_t: Tunnel, _s?: unknown, _replace?: boolean) => ({ id: 't1', iface: 'utun7' })),
    down: vi.fn(async () => {}),
    stats: vi.fn(async () => ({ rxBytes: 0, txBytes: 0, lastHandshakeSec: 0 })),
    recover: vi.fn(async (): Promise<{ id: string; iface: string } | null> => null),
    hasStaleState: vi.fn(async () => true),
    cleanup: vi.fn(async () => {}),
    ...over
  }
  const log = new Logger()
  let last: AppState | null = null
  const probe = async () => ({ routeIface: 'utun7', resolverIface: 'default', tcp: 'ok' as const, tcpMs: 1, dns: 'ok' as const, rxDelta: 1, txDelta: 1 })
  const manager = new TunnelManager(controller, (s) => (last = s), log, tail, probe)
  return { controller, log, manager, state: () => last! }
}

beforeEach(() => vi.clearAllMocks())

describe('stale session after a reboot', () => {
  it('is reported on start, with a warning in the journal', async () => {
    const { manager, log, state } = setup()
    await manager.init()
    expect(state().needsCleanup).toBe(true)
    expect(log.list().some((e) => e.level === 'warn' && e.message.includes('Восстановить сеть'))).toBe(true)
  })

  it('is not reported when the previous tunnel is still alive', async () => {
    const { manager, controller, state } = setup({ recover: vi.fn(async () => ({ id: 't1', iface: 'utun7' })) })
    await manager.init()
    manager.dispose()
    expect(controller.hasStaleState).not.toHaveBeenCalled()
    expect(state().needsCleanup).toBe(false)
  })

  it('cleanup clears it', async () => {
    const { manager, controller, state } = setup()
    await manager.init()
    await manager.cleanup()
    expect(controller.cleanup).toHaveBeenCalledOnce()
    expect(state().needsCleanup).toBe(false)
    expect(state().busy).toBe(false)
  })

  it('a cancelled admin prompt keeps the warning', async () => {
    const { manager, state } = setup({ cleanup: vi.fn(async () => { throw new UserCancelledError() }) })
    await manager.init()
    await manager.cleanup()
    expect(state().needsCleanup).toBe(true)
  })

  it('a successful connect clears it (awg.sh up removes leftovers first)', async () => {
    const { manager, state } = setup()
    await manager.init()
    await manager.connect('t1')
    manager.dispose()
    expect(state().needsCleanup).toBe(false)
  })

  it('a failed connect re-checks what is left', async () => {
    const { manager, controller, state } = setup({ up: vi.fn(async () => { throw new Error('boom') }) })
    await manager.init()
    controller.hasStaleState.mockResolvedValueOnce(false)
    await manager.connect('t1')
    expect(state().needsCleanup).toBe(false)
  })

  it('refuses cleanup while a tunnel is active', async () => {
    const { manager } = setup()
    await manager.connect('t1')
    await expect(manager.cleanup()).rejects.toThrow(/^TUN-05: /)
    manager.dispose()
  })
})

describe('connectivity check', () => {
  it('runs once after the first handshake and logs the verdict', async () => {
    const now = () => Math.floor(Date.now() / 1000)
    const { manager, log } = setup({
      hasStaleState: vi.fn(async () => false),
      stats: vi.fn(async () => ({ rxBytes: 10, txBytes: 10, lastHandshakeSec: now() }))
    })
    await manager.connect('t1')
    await vi.waitFor(() => expect(log.list().some((e) => e.message.startsWith('Проверка связи'))).toBe(true), { timeout: 3000 })
    manager.dispose()
    expect(log.list().filter((e) => e.message.startsWith('Проверка связи'))).toHaveLength(1)
  })
})

describe('diagnostics setting', () => {
  it('reports the setting in state and only reads the capture when it was on at connect time', async () => {
    let enabled = false
    const readCapture = vi.fn(async () => ({ inner: '', outer: '' }))
    const controller = {
      up: vi.fn(async () => ({ id: 't1', iface: 'utun7', endpointIp: '2.27.175.125', localIp: '10.9.0.6' })),
      down: vi.fn(async () => {}),
      stats: vi.fn(async () => ({ rxBytes: 1, txBytes: 1, lastHandshakeSec: Math.floor(Date.now() / 1000) })),
      recover: vi.fn(async (): Promise<{ id: string; iface: string } | null> => null),
      hasStaleState: vi.fn(async () => false),
      cleanup: vi.fn(async () => {}),
      readCapture
    }
    let last: AppState | null = null
    const probe = async () => ({ routeIface: 'utun7', resolverIface: 'default', tcp: 'ok' as const, tcpMs: 1, dns: 'ok' as const, rxDelta: 1, txDelta: 1 })
    const m = new TunnelManager(controller, (s) => (last = s), new Logger(), tail, probe, () => enabled)
    await m.init()
    expect(last!.diagnostics).toBe(false)
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await m.connect('t1')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(readCapture).not.toHaveBeenCalled()
    m.dispose()
    vi.useRealTimers()
    enabled = true
    await m.init()
    expect(last!.diagnostics).toBe(true)
  })
})

describe('switching servers while connected', () => {
  const upOn = (iface: string) => async (t: Tunnel) => ({ id: t.id, iface })

  it('replaces the running tunnel in one privileged call, without a separate disconnect', async () => {
    const { manager, controller, state } = setup({ up: vi.fn(upOn('utun7')) })
    await manager.connect('t1')
    controller.up.mockImplementationOnce(upOn('utun8'))
    const switching = manager.connect('t2')
    expect(state().switching).toBe(true)
    expect(state().states.t1.status).toBe('down')
    await switching
    manager.dispose()
    expect(controller.down).not.toHaveBeenCalled()
    expect(controller.up).toHaveBeenLastCalledWith(tunnel2, { privateKey: 'k' }, true)
    expect(controller.up.mock.calls[0][2]).toBe(false)
    expect(state().activeId).toBe('t2')
    expect(state().switching).toBe(false)
  })

  it('keeps the old tunnel when the switch is cancelled before it was touched', async () => {
    const { manager, controller, state, log } = setup({ up: vi.fn(upOn('utun7')) })
    await manager.connect('t1')
    controller.up.mockRejectedValueOnce(new UserCancelledError())
    controller.recover.mockResolvedValueOnce({ id: 't1', iface: 'utun7' })
    await manager.connect('t2')
    manager.dispose()
    expect(state().activeId).toBe('t1')
    expect(state().states.t2.status).toBe('down')
    expect(state().states.t1.status).not.toBe('down')
    expect(log.list().some((e) => e.message === 'Прежний туннель продолжает работать')).toBe(true)
  })

  it('reports the VPN as off when the new tunnel failed after the old one was stopped', async () => {
    const { manager, controller, state, log } = setup({ up: vi.fn(upOn('utun7')) })
    await manager.connect('t1')
    controller.up.mockRejectedValueOnce(new Error('Интерфейс не поднялся за 10 секунд'))
    await manager.connect('t2')
    manager.dispose()
    expect(state().activeId).toBeNull()
    expect(state().states.t1.status).toBe('down')
    expect(state().states.t2).toMatchObject({ status: 'error', error: 'TUN-07: VPN не включился — попробуйте ещё раз' })
    expect(log.list().some((e) => e.level === 'warn' && e.message.includes('VPN выключен'))).toBe(true)
  })

  it('does nothing when the running server is picked again', async () => {
    const { manager, controller } = setup({ up: vi.fn(upOn('utun7')) })
    await manager.connect('t1')
    await manager.connect('t1')
    manager.dispose()
    expect(controller.up).toHaveBeenCalledOnce()
  })
})

describe('connection age', () => {
  const fresh = { rxBytes: 1, txBytes: 1, lastHandshakeSec: Math.floor(Date.now() / 1000) }

  it('for a tunnel found running at start-up is its real start time, not «just now»', async () => {
    const startedAt = Date.now() - 3 * 60 * 60 * 1000
    const { manager, state } = setup({
      recover: vi.fn(async () => ({ id: 't1', iface: 'utun7', startedAt })),
      stats: vi.fn(async () => fresh)
    })
    await manager.init()
    await vi.waitFor(() => expect(state().states.t1.status).toBe('up'))
    manager.dispose()
    expect(state().states.t1.since).toBe(startedAt)
  })

  it('is left out when that start time is unknown', async () => {
    const { manager, state } = setup({
      recover: vi.fn(async () => ({ id: 't1', iface: 'utun7' })),
      stats: vi.fn(async () => fresh)
    })
    await manager.init()
    await vi.waitFor(() => expect(state().states.t1.status).toBe('up'))
    manager.dispose()
    expect(state().states.t1.since).toBeUndefined()
  })

  it('for a new connection starts at its first handshake', async () => {
    const { manager, state } = setup({ stats: vi.fn(async () => fresh) })
    const before = Date.now()
    await manager.connect('t1')
    // The first poll is skipped while connect() is still busy; the next one comes a second later.
    await vi.waitFor(() => expect(state().states.t1.status).toBe('up'), { timeout: 3000 })
    manager.dispose()
    expect(state().states.t1.since).toBeGreaterThanOrEqual(before)
  })
})

describe('a tunnel that will not recover by itself', () => {
  const FAIL = "peer(sF+y…23gs) - Failed to send data packets: write udp4 0.0.0.0:63924->2.27.175.125:47619: sendmsg: can't assign requested address"
  const fresh = () => ({ rxBytes: 1, txBytes: 1, lastHandshakeSec: Math.floor(Date.now() / 1000) })

  afterEach(() => vi.useRealTimers())

  it('a lost route is reported once the failures outlast a network change, and cleared when the server answers', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { manager, log, state } = setup({ hasStaleState: vi.fn(async () => false), stats: vi.fn(async () => fresh()) })
    await manager.connect('t1')
    manager.daemonLines([FAIL])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(state().degraded).toBeNull() // a moment of it is every network change
    for (let i = 0; i < 10; i++) {
      manager.daemonLines([FAIL])
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(state().degraded).toMatch(/Связь с сервером потеряна/)
    expect(log.list().filter((e) => e.level === 'warn' && e.message.includes('Связь с сервером потеряна'))).toHaveLength(1)

    manager.daemonLines(['peer(sF+y…23gs) - Received handshake response'])
    await vi.advanceTimersByTimeAsync(1_000)
    manager.dispose()
    expect(state().degraded).toBeNull()
    expect(log.list().some((e) => e.message === 'Связь с сервером восстановлена')).toBe(true)
  })

  it('Linux\'s «network is unreachable» counts as a lost route too', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { manager, state } = setup({ hasStaleState: vi.fn(async () => false), stats: vi.fn(async () => fresh()) })
    await manager.connect('t1')
    for (let i = 0; i < 12; i++) {
      manager.daemonLines(['peer(PEz4…4hhA) - Failed to send data packets: write udp 0.0.0.0:35426: sendmmsg: network is unreachable'])
      await vi.advanceTimersByTimeAsync(1_000)
    }
    manager.dispose()
    expect(state().degraded).toMatch(/Связь с сервером потеряна/)
  })

  it('a failure that stops quickly is forgotten', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { manager, state } = setup({ hasStaleState: vi.fn(async () => false), stats: vi.fn(async () => fresh()) })
    await manager.connect('t1')
    manager.daemonLines([FAIL, FAIL])
    await vi.advanceTimersByTimeAsync(3_000)
    manager.daemonLines([FAIL])
    await vi.advanceTimersByTimeAsync(70_000)
    manager.daemonLines([FAIL])
    await vi.advanceTimersByTimeAsync(5_000)
    manager.dispose()
    expect(state().degraded).toBeNull()
  })

  it('a tunnel adopted without its watcher is reported at once', async () => {
    const { manager, log, state } = setup({
      recover: vi.fn(async () => ({ id: 't1', iface: 'utun7' })),
      watchdogAlive: vi.fn(async () => false)
    })
    await manager.init()
    manager.dispose()
    expect(state().degraded).toMatch(/Фоновый процесс туннеля не работает/)
    expect(log.list().some((e) => e.level === 'warn' && e.message.includes('Фоновый процесс'))).toBe(true)
  })

  it('reconnect brings the same tunnel up again in one privileged call and clears the warning', async () => {
    const watchdogAlive = vi.fn(async () => false)
    const { manager, controller, state, log } = setup({
      recover: vi.fn(async () => ({ id: 't1', iface: 'utun7' })),
      watchdogAlive
    })
    await manager.init()
    watchdogAlive.mockResolvedValue(true)
    await manager.reconnect()
    await vi.waitFor(() => expect(watchdogAlive).toHaveBeenCalledTimes(2), { timeout: 3000 })
    manager.dispose()
    expect(controller.up).toHaveBeenCalledWith(tunnel, { privateKey: 'k' }, true)
    expect(controller.down).not.toHaveBeenCalled()
    expect(state().activeId).toBe('t1')
    expect(state().degraded).toBeNull()
    expect(log.list().some((e) => e.message.startsWith('Переподключение к «Германия»'))).toBe(true)
  })

  it('reconnect refuses when nothing is connected', async () => {
    const { manager } = setup()
    await expect(manager.reconnect()).rejects.toThrow(/^TUN-06: /)
  })
})

describe('periodic connectivity recheck', () => {
  const ok = { routeIface: 'utun7', resolverIface: 'default', tcp: 'ok' as const, tcpMs: 1, dns: 'ok' as const, rxDelta: 1, txDelta: 1 }
  const bad = { ...ok, tcp: 'timeout' as const, tcpMs: undefined }

  function live(results: (typeof ok | typeof bad)[], every: number) {
    const controller = {
      up: vi.fn(async () => ({ id: 't1', iface: 'utun7' })),
      down: vi.fn(async () => {}),
      stats: vi.fn(async () => ({ rxBytes: 1, txBytes: 1, lastHandshakeSec: Math.floor(Date.now() / 1000) })),
      recover: vi.fn(async (): Promise<{ id: string; iface: string } | null> => null),
      hasStaleState: vi.fn(async () => false),
      cleanup: vi.fn(async () => {})
    }
    let last: AppState | null = null
    const probe = vi.fn(async () => results.shift() ?? ok)
    const m = new TunnelManager(controller, (s) => (last = s), new Logger(), tail, probe, () => false, {}, () => every)
    return { m, probe, state: () => last! }
  }

  it('warns after two failed probes in a row and clears when traffic returns', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { m, probe, state } = live([ok, bad, bad, ok], 30_000)
    await m.connect('t1')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(probe).toHaveBeenCalledTimes(1) // the one at the handshake
    await vi.advanceTimersByTimeAsync(31_000)
    expect(state().degraded).toBeNull() // one failure is not enough
    await vi.advanceTimersByTimeAsync(31_000)
    expect(state().degraded).toContain('ничего не проходит')
    await vi.advanceTimersByTimeAsync(31_000)
    expect(state().degraded).toBeNull()
    m.dispose()
    vi.useRealTimers()
  })

  it('never probes again when the interval is 0', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { m, probe } = live([], 0)
    await m.connect('t1')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(probe).toHaveBeenCalledTimes(1)
    m.dispose()
    vi.useRealTimers()
  })
})

describe('the daemon dying under a connected tunnel', () => {
  const run = async (failsClosed: boolean) => {
    let alive = true
    const { manager, log, state } = setup({
      failsClosed,
      hasStaleState: vi.fn(async () => !alive),
      stats: vi.fn(async () => {
        if (!alive) throw new Error('socket closed')
        return { rxBytes: 1, txBytes: 1, lastHandshakeSec: Math.floor(Date.now() / 1000) }
      })
    })
    await manager.connect('t1')
    alive = false
    await vi.waitFor(() => expect(state().states.t1.status).toBe('error'), { timeout: 3000 })
    await vi.waitFor(() => expect(state().needsCleanup).toBe(true))
    manager.dispose()
    return log.list().some((e) => e.level === 'warn' && e.message.includes('заблокировано'))
  }

  it('offers «Восстановить сеть» and says traffic is held where the platform holds it', async () => {
    expect(await run(true)).toBe(true)
  })

  it('does not claim a block where there is none', async () => {
    expect(await run(false)).toBe(false)
  })
})

describe('a master key that refuses the connect', () => {
  function refusing(refuse: boolean) {
    const s = setup()
    const hooks = {
      beforeConnect: vi.fn(async () => {
        if (refuse) throw new AppError('KEY-21', undefined, 'Мастер-ключ «Семья»')
      })
    }
    const manager = new TunnelManager(s.controller, () => {}, s.log, tail, undefined, () => false, hooks)
    return { ...s, manager, state: () => manager.snapshot() }
  }

  it('does not bring the tunnel up, and the card and the journal say why', async () => {
    const { manager, controller, log, state } = refusing(true)
    await manager.connect('t1')
    expect(controller.up).not.toHaveBeenCalled()
    expect(state().states.t1).toMatchObject({ status: 'error', error: expect.stringMatching(/^KEY-21: /) })
    expect(log.list().some((e) => e.level === 'error' && e.message.startsWith('[KEY-21]') && e.message.endsWith('· Мастер-ключ «Семья»'))).toBe(true)
    expect(state().busy).toBe(false)
  })

  it('a hook that only failed lets the connect go ahead', async () => {
    const { manager, controller } = refusing(false)
    await manager.connect('t1')
    manager.dispose()
    expect(controller.up).toHaveBeenCalledOnce()
  })
})

describe('reconnecting by itself', () => {
  const FAIL = "peer(sF+y…23gs) - Failed to send data packets: write udp4 0.0.0.0:63924->2.27.175.125:47619: sendmsg: can't assign requested address"
  const fresh = () => ({ rxBytes: 1, txBytes: 1, lastHandshakeSec: Math.floor(Date.now() / 1000) })

  function healing(over: Record<string, unknown> = {}, online = true) {
    const s = setup({ hasStaleState: vi.fn(async () => false), stats: vi.fn(async () => fresh()), ...over })
    let last: AppState | null = null
    const probe = async () => ({ routeIface: 'utun7', resolverIface: 'default', tcp: 'ok' as const, tcpMs: 1, dns: 'ok' as const, rxDelta: 1, txDelta: 1 })
    const manager = new TunnelManager(s.controller, (st) => (last = st), s.log, tail, probe, () => false, {}, () => 0, () => null, () => online)
    return { ...s, manager, state: () => last! }
  }
  const told = (log: InstanceType<typeof Logger>, text: string) => log.list().filter((e) => e.message.includes(text)).length

  async function loseRoute(manager: InstanceType<typeof TunnelManager>) {
    for (let i = 0; i < 12; i++) {
      manager.daemonLines([FAIL])
      await vi.advanceTimersByTimeAsync(1_000)
    }
  }

  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
  afterEach(() => vi.useRealTimers())

  it('a route lost after a network change: the tunnel is brought up again, replacing the old one', async () => {
    const { manager, controller, log, state } = healing()
    await manager.connect('t1')
    await loseRoute(manager)
    await vi.advanceTimersByTimeAsync(3_000)
    manager.dispose()
    expect(controller.up).toHaveBeenCalledTimes(2)
    expect(controller.up.mock.calls[1][2]).toBe(true)
    expect(told(log, 'Переподключаюсь сам (попытка 1 из 3): связь с сервером потеряна')).toBe(1)
    expect(state().activeId).toBe('t1')
    expect(state().degraded).toBeNull()
  })

  it('not without a network: the reconnect would fail and leave the VPN off', async () => {
    const { manager, controller, state } = healing({}, false)
    await manager.connect('t1')
    await loseRoute(manager)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(state().degraded).toMatch(/Связь с сервером потеряна/)
    await vi.advanceTimersByTimeAsync(60_000)
    manager.dispose()
    expect(controller.up).toHaveBeenCalledOnce()
  })

  it('not where every privileged call asks for the password', async () => {
    const { manager, controller } = healing({ asksEachTime: true })
    await manager.connect('t1')
    await loseRoute(manager)
    await vi.advanceTimersByTimeAsync(60_000)
    manager.dispose()
    expect(controller.up).toHaveBeenCalledOnce()
  })

  it('a dead watcher: three attempts with growing pauses, then the card asks the user', async () => {
    const { manager, controller, log, state } = healing({ watchdogAlive: vi.fn(async () => false) })
    await manager.connect('t1')
    await vi.advanceTimersByTimeAsync(4_000)
    expect(controller.up).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(controller.up).toHaveBeenCalledTimes(2) // the second waits 10 s
    await vi.advanceTimersByTimeAsync(8_000)
    expect(controller.up).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(35_000)
    expect(controller.up).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(120_000)
    manager.dispose()
    expect(controller.up).toHaveBeenCalledTimes(4)
    expect(told(log, 'Переподключиться само не получилось')).toBe(1)
    expect(state().degraded).toMatch(/Фоновый процесс туннеля не работает/)
  })

  it('a reconnect by hand gives the attempts back', async () => {
    const { manager, controller } = healing({ watchdogAlive: vi.fn(async () => false) })
    await manager.connect('t1')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(controller.up).toHaveBeenCalledTimes(4)
    await manager.reconnect()
    await vi.advanceTimersByTimeAsync(4_000)
    manager.dispose()
    expect(controller.up).toHaveBeenCalledTimes(6)
  })

  it('nothing after the user disconnected', async () => {
    const { manager, controller } = healing({ watchdogAlive: vi.fn(async () => false) })
    await manager.connect('t1')
    await vi.advanceTimersByTimeAsync(1_000)
    await manager.disconnect('t1')
    await vi.advanceTimersByTimeAsync(60_000)
    manager.dispose()
    expect(controller.up).toHaveBeenCalledOnce()
  })

  it('after sleep: only when the handshake has not come back by itself', async () => {
    let handshake = Math.floor(Date.now() / 1000)
    const { manager, controller, log } = healing({ stats: vi.fn(async () => ({ rxBytes: 1, txBytes: 1, lastHandshakeSec: handshake })) })
    await manager.connect('t1')
    await vi.advanceTimersByTimeAsync(2_000)
    handshake -= 600 // slept for ten minutes
    manager.woke()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(controller.up).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(controller.up).toHaveBeenCalledTimes(2)
    expect(told(log, 'после выхода из сна нет рукопожатия')).toBe(1)

    handshake = Math.floor(Date.now() / 1000)
    await vi.advanceTimersByTimeAsync(2_000)
    manager.woke()
    await vi.advanceTimersByTimeAsync(60_000)
    manager.dispose()
    expect(controller.up).toHaveBeenCalledTimes(2)
  })

  it('a daemon that does not answer (TUN-09) is brought up again, not reported dead', async () => {
    let hung = false
    const { manager, controller, state } = healing({
      stats: vi.fn(async () => {
        if (hung) {
          hung = false
          throw new AppError('TUN-09', undefined, 'UAPI: нет ответа от amneziawg-go')
        }
        return fresh()
      })
    })
    await manager.connect('t1')
    await vi.advanceTimersByTimeAsync(2_000)
    hung = true
    await vi.advanceTimersByTimeAsync(3_000)
    manager.dispose()
    expect(controller.up).toHaveBeenCalledTimes(2)
    expect(state().activeId).toBe('t1')
    expect(state().states.t1.status).not.toBe('error')
  })

  it('an interface the system did not name (TUN-10) is brought up once more', async () => {
    const { manager, controller, state } = healing()
    controller.up.mockRejectedValueOnce(new AppError('TUN-10'))
    await manager.connect('t1')
    manager.dispose()
    expect(controller.up).toHaveBeenCalledTimes(2)
    expect(controller.up.mock.calls[1][2]).toBe(true)
    expect(state().activeId).toBe('t1')
  })
})

describe('leftovers of a dead session at start-up', () => {
  it('are taken down at once when nothing connects after', async () => {
    const { manager, controller, state, log } = setup()
    await manager.init({ cleanup: true })
    expect(controller.cleanup).toHaveBeenCalledOnce()
    expect(state().needsCleanup).toBe(false)
    expect(log.list().some((e) => e.message === 'Сетевые настройки восстановлены')).toBe(true)
  })

  it('stay, with the button, where the cleanup would ask for the password', async () => {
    const { manager, controller, state } = setup({ asksEachTime: true })
    await manager.init({ cleanup: true })
    expect(controller.cleanup).not.toHaveBeenCalled()
    expect(state().needsCleanup).toBe(true)
  })
})
