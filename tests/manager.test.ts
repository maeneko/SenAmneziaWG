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
    await expect(manager.cleanup()).rejects.toThrow(/Туннель активен/)
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
    expect(state().states.t2).toMatchObject({ status: 'error', error: 'Интерфейс не поднялся за 10 секунд' })
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
    await expect(manager.reconnect()).rejects.toThrow(/не подключён/)
  })
})
