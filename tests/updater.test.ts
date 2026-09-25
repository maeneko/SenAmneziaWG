import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateState } from '../src/shared/types'
import { createUpdater, InstallCancelled, noServer, simulated, type Found, type UpdateSource, type UpdaterDeps } from '../src/main/update/updater'

const FOUND: Found = { version: '0.6.0', notes: ['новое'], total: 30 }

/** A server that offers FOUND and hands it over in three chunks. */
function server(overrides: Partial<UpdateSource> = {}): UpdateSource & { downloads: number } {
  const s = {
    downloads: 0,
    check: async () => FOUND,
    async download(found: Found, report: (received: number) => void) {
      s.downloads++
      for (const received of [10, 20]) report(received)
      return { kind: 'ready' as const, version: found.version, notes: found.notes }
    },
    ...overrides
  }
  return s
}

function updater(source: UpdateSource, extra: Partial<UpdaterDeps> = {}) {
  const sent: UpdateState[] = []
  const logs: string[] = []
  const u = createUpdater({
    source,
    automatic: () => true,
    install: () => Promise.resolve(),
    send: (s) => sent.push(s),
    log: (level, m) => logs.push(`${level}: ${m}`),
    now: () => 1000,
    ...extra
  })
  return { u, sent, logs, kinds: () => sent.map((s) => s.kind) }
}

describe('updater', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('starts never checked', () => {
    expect(updater(noServer()).u.get()).toEqual({ kind: 'idle', checkedAt: null })
  })

  it('without a server, a check ends in «nothing newer» at the time it finished', async () => {
    const { u, kinds } = updater(noServer())
    const done = u.check()
    expect(u.get()).toEqual({ kind: 'checking' })
    await vi.advanceTimersByTimeAsync(800)
    await done
    expect(kinds()).toEqual(['checking', 'idle'])
    expect(u.get()).toEqual({ kind: 'idle', checkedAt: 1000 })
  })

  it('with «Обновлять автоматически» on, a found version downloads by itself', async () => {
    const { u, sent, kinds } = updater(server())
    await u.check()
    expect(kinds()).toEqual(['checking', 'downloading', 'downloading', 'downloading', 'ready'])
    expect(sent.filter((s) => s.kind === 'downloading').map((s) => (s as { received: number }).received)).toEqual([0, 10, 20])
  })

  it('with it off, a found version waits for «Скачать обновление»', async () => {
    const source = server()
    const { u, kinds } = updater(source, { automatic: () => false })
    await u.check()
    expect(u.get()).toEqual({ kind: 'available', ...FOUND })
    expect(source.downloads).toBe(0)
    await u.download()
    expect(kinds()).toEqual(['checking', 'available', 'downloading', 'downloading', 'downloading', 'ready'])
  })

  it('downloads only what is available', async () => {
    const source = server()
    const { u } = updater(source)
    await u.download()
    expect(source.downloads).toBe(0)
    expect(u.get().kind).toBe('idle')
  })

  it('does not check again over a version already found', async () => {
    let checks = 0
    const { u } = updater(server({ check: async () => (checks++, FOUND) }), { automatic: () => false })
    await u.check()
    await u.check()
    expect(checks).toBe(1)
    expect(u.get().kind).toBe('available')
  })

  it('runs one check at a time', async () => {
    let checks = 0
    const { u } = updater(server({ check: async () => (checks++, await new Promise((r) => setTimeout(r, 100)), null) }))
    const first = u.check()
    await u.check()
    await vi.advanceTimersByTimeAsync(100)
    await first
    expect(checks).toBe(1)
  })

  it('a check that throws is a network failure, not a crash — and can be retried', async () => {
    let fail = true
    const { u, logs } = updater(server({ check: async () => (fail ? Promise.reject(new Error('ECONNREFUSED')) : null) }))
    await u.check()
    expect(u.get()).toEqual({ kind: 'failed', reason: 'network', message: 'ECONNREFUSED' })
    expect(logs).toEqual(['warn: Обновления: ECONNREFUSED'])
    fail = false
    await u.check()
    expect(u.get()).toEqual({ kind: 'idle', checkedAt: 1000 })
  })

  it('a download that breaks off is a failure too', async () => {
    const { u } = updater(server({ download: () => Promise.reject(new Error('обрыв')) }))
    await u.check()
    expect(u.get()).toMatchObject({ kind: 'failed', message: 'обрыв' })
  })

  it('installs only what is ready', async () => {
    const install = vi.fn(() => Promise.resolve())
    const { u } = updater(server(), { automatic: () => false, install })
    await u.check()
    await u.install()
    expect(install).not.toHaveBeenCalled()
  })

  it('hands the downloaded installer to install, and never shows its path to the window', async () => {
    const install = vi.fn((_version: string, _file: string | undefined) => Promise.resolve())
    const source = server({
      download: async (found: Found) => ({ kind: 'ready' as const, version: found.version, notes: found.notes, file: 'C:\\Temp\\SenAWG-0.6.0-setup.exe' })
    })
    const { u, sent } = updater(source, { install })
    await u.check()
    expect(sent.at(-1)).toEqual({ kind: 'ready', version: '0.6.0', notes: ['новое'] })
    await u.install()
    expect(install).toHaveBeenCalledWith('0.6.0', 'C:\\Temp\\SenAWG-0.6.0-setup.exe')
  })

  it('install goes through «installing»; a failed one says why', async () => {
    const { u, kinds } = updater(server(), { install: () => Promise.reject(new Error('нет места на диске')) })
    await u.check()
    await u.install()
    expect(kinds().slice(-3)).toEqual(['ready', 'installing', 'failed'])
    expect(u.get()).toMatchObject({ reason: 'network', message: 'нет места на диске', installing: true })
  })

  it('an install called off (the prompt declined) goes back to «ready» with the reason, not to «failed»', async () => {
    const install = vi.fn().mockRejectedValueOnce(new InstallCancelled('Обновление отменено')).mockResolvedValueOnce(undefined)
    const { u, kinds } = updater(server(), { install })
    await u.check()
    await u.install()
    expect(kinds().slice(-3)).toEqual(['ready', 'installing', 'ready'])
    expect(u.get()).toMatchObject({ kind: 'ready', version: '0.6.0', notes: ['новое'], message: 'Обновление отменено' })
    await u.install() // and it can simply be pressed again
    expect(u.get()).toMatchObject({ kind: 'idle' })
  })

  it('the simulation offers 0.6.0 and downloads it', async () => {
    const { u } = updater(simulated('available', 1), { automatic: () => false })
    const checked = u.check()
    await vi.runAllTimersAsync()
    await checked
    expect(u.get()).toMatchObject({ kind: 'available', version: '0.6.0' })
    const downloaded = u.download()
    await vi.runAllTimersAsync()
    await downloaded
    expect(u.get()).toMatchObject({ kind: 'ready', version: '0.6.0' })
  })

  it.each(['revoked', 'unsupported', 'network'] as const)('the simulation can end in «%s»', async (reason) => {
    const { u } = updater(simulated(reason, 1))
    const done = u.check()
    await vi.runAllTimersAsync()
    await done
    expect(u.get()).toMatchObject({ kind: 'failed', reason })
  })
})
