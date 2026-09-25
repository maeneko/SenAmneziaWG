import { createServer, type Server } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseWgConfig } from '../src/main/config/wgConfig'
import { readMacService, removeMacService, serviceBuildId } from '../src/main/tunnel/macos/service'
import { usesService } from '../src/main/tunnel/macosBackend'
import { MacosServiceController } from '../src/main/tunnel/macosServiceController'
import { UserCancelledError } from '../src/main/tunnel/TunnelController'
import { HelperClient, type HelperStarter } from '../src/main/tunnel/windows/helperClient'
import type { HelperRequest, HelperResponse } from '../src/main/tunnel/windows/protocol'

const KEY = Buffer.alloc(32, 1).toString('base64')
const KEY_B = Buffer.alloc(32, 2).toString('base64')
const INI = `[Interface]\nPrivateKey = ${KEY}\nAddress = 10.8.1.2/32, fd00::2/128\nDNS = 1.1.1.1\n\n[Peer]\nPublicKey = ${KEY_B}\nAllowedIPs = 0.0.0.0/0\nEndpoint = 203.0.113.7:51820\n`
const { tunnel, secrets } = parseWgConfig(INI, { name: 'Дом' })

// The daemon postinstall builds; checkBinaryFor runs it for its version, as a real connect does.
const BINARY = join(__dirname, '..', 'resources', 'bin', 'amneziawg-go')
const withBinary = it.skipIf(process.platform !== 'darwin' || !existsSync(BINARY))

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'senawg-mac-'))
  dirs.push(d)
  return d
}

/** The three service files, laid out as Contents/Resources has them — helper/macinstall_test.go's fixture. */
function resourcesFixture(): string {
  const res = tempDir()
  for (const [name, source] of [
    ['awg-helper', 'bin/awg-helper'],
    ['amneziawg-go', 'bin/amneziawg-go'],
    ['awg.sh', 'scripts/awg.sh']
  ]) {
    mkdirSync(dirname(join(res, source)), { recursive: true })
    writeFileSync(join(res, source), `content of ${name}\n`)
  }
  return res
}
const FIXTURE_BUILD = 'a6180229431be0f16ec837ea976c1bee67a7f53cb261c7d92cf255c70d3b396f'

describe('serviceBuildId', () => {
  // Pinned in helper/macinstall_test.go (TestBuildIDVector): the app and the service must agree byte for byte.
  it('matches the service’s own build id for the same files', async () => {
    expect(await serviceBuildId(resourcesFixture())).toBe(FIXTURE_BUILD)
  })

  it('fails when a file is missing, instead of hashing what is there', async () => {
    await expect(serviceBuildId(tempDir())).rejects.toThrow()
  })
})

describe('usesService', () => {
  it('always in a packaged app; in development only when asked for', () => {
    expect(usesService(true, {})).toBe(true)
    expect(usesService(false, {})).toBe(false)
    expect(usesService(false, { SENAWG_MAC_SERVICE: '1' })).toBe(true)
  })
})

const BUILD = 'b'.repeat(64)

/** A scripted service: hello reports `builds` in turn (the last one repeats), every request is recorded. */
function fakeClient(builds: string[] = [BUILD], answers: Partial<Record<HelperRequest['op'], HelperResponse>> = {}) {
  const calls: HelperRequest[] = []
  let hellos = 0
  const request = vi.fn(async (req: HelperRequest): Promise<HelperResponse> => {
    calls.push(req)
    if (req.op === 'hello') {
      const build = builds[Math.min(hellos++, builds.length - 1)]
      return { ok: true, protocol: 1, helper: '0.7.0', awgGo: 'v3.1.20260828', build }
    }
    return answers[req.op] ?? { ok: true }
  })
  return { client: { request } as unknown as HelperClient, calls }
}

function controller(client: HelperClient, install = vi.fn(async () => {}), diagnostics = false) {
  const c = new MacosServiceController(client, '/res', BINARY, () => {}, () => diagnostics, (t) => t.dns, install, async () => BUILD)
  return { c, install }
}

describe('MacosServiceController', () => {
  withBinary('connects through the service: the UAPI body plus what awg.sh takes as flags', async () => {
    const { client, calls } = fakeClient([BUILD], { up: { ok: true, iface: 'utun7', endpointIp: '203.0.113.7' } })
    const { c, install } = controller(client, undefined, true)
    const active = await c.up(tunnel, secrets, true)
    expect(install).not.toHaveBeenCalled()
    const up = calls.find((r) => r.op === 'up')!
    expect(up).toMatchObject({ id: tunnel.id, name: 'Дом', replace: true, mtu: 1280, dns: ['1.1.1.1'], diagnostics: true })
    expect(up.address).toEqual(['10.8.1.2/32', 'fd00::2/128'])
    expect(up.conf).toMatch(/^set=1\n/)
    expect(up.conf).toContain('endpoint=203.0.113.7:51820')
    expect(active).toEqual({ id: tunnel.id, iface: 'utun7', endpointIp: '203.0.113.7', localIp: '10.8.1.2' })
  })

  withBinary('leaves diagnostics out when they are off', async () => {
    const { client, calls } = fakeClient([BUILD], { up: { ok: true, iface: 'utun7' } })
    await controller(client).c.up(tunnel, secrets)
    expect(calls.find((r) => r.op === 'up')?.diagnostics).toBeUndefined()
  })

  withBinary('reinstalls a service from another build before connecting', async () => {
    const { client, calls } = fakeClient(['old'.padEnd(64, '0'), BUILD], { up: { ok: true, iface: 'utun7' } })
    const { c, install } = controller(client)
    await c.up(tunnel, secrets)
    expect(install).toHaveBeenCalledTimes(1)
    expect(install).toHaveBeenCalledWith('/res')
    expect(calls.map((r) => r.op)).toEqual(['hello', 'hello', 'up'])
  })

  withBinary('does not connect through a service that is still the old one after reinstalling', async () => {
    const { client, calls } = fakeClient(['old'.padEnd(64, '0')])
    await expect(controller(client).c.up(tunnel, secrets)).rejects.toThrow(/не обновилась/)
    expect(calls.some((r) => r.op === 'up')).toBe(false)
  })

  withBinary('a declined prompt is a cancelled connection, and nothing is sent', async () => {
    const { client, calls } = fakeClient(['old'.padEnd(64, '0')])
    const install = vi.fn(async () => {
      throw new UserCancelledError()
    })
    await expect(controller(client, install).c.up(tunnel, secrets)).rejects.toBeInstanceOf(UserCancelledError)
    expect(calls.some((r) => r.op === 'up')).toBe(false)
  })

  it('disconnects and cleans up through the service', async () => {
    const { client, calls } = fakeClient()
    const { c } = controller(client)
    await c.down({ id: 'x', iface: 'utun7' })
    await c.cleanup()
    expect(calls.map((r) => r.op)).toEqual(['down', 'cleanup'])
  })
})

describe('HelperClient with the macOS starter', () => {
  let server: Server | null = null
  afterEach(() => {
    server?.close()
    server = null
  })

  const listen = (path: string): void => {
    server = createServer((sock) => sock.on('data', () => sock.end('{"ok":true,"protocol":1}\n'))).listen(path)
  }

  it('no socket: installs the service once, then asks again', async () => {
    const path = join(tempDir(), 's.sock')
    const start = vi.fn(async () => {
      listen(path) // what `awg-helper install` leaves behind: launchd's socket
      return 0
    })
    const starter: HelperStarter = { start, accepted: (c) => c === 0, failure: () => null }
    const client = new HelperClient(path, starter)
    const [a, b] = await Promise.all([client.request({ op: 'hello' }), client.request({ op: 'hello' })])
    expect(a.ok && b.ok).toBe(true)
    expect(start).toHaveBeenCalledTimes(1) // two requests at once, one prompt
  })

  it('a declined prompt rejects with UserCancelledError, and the next request asks again', async () => {
    const path = join(tempDir(), 's.sock')
    const start = vi.fn(async (): Promise<number> => {
      throw new UserCancelledError()
    })
    const client = new HelperClient(path, { start, accepted: (c) => c === 0, failure: () => null })
    await expect(client.request({ op: 'hello' })).rejects.toBeInstanceOf(UserCancelledError)
    await expect(client.request({ op: 'hello' })).rejects.toBeInstanceOf(UserCancelledError)
    expect(start).toHaveBeenCalledTimes(2)
  })
})

describe('readMacService', () => {
  const plist = (): string => {
    const p = join(tempDir(), 'ru.senawg.helper.plist')
    writeFileSync(p, '')
    return p
  }

  it('no plist: not installed, and the service is not asked (asking must never install it)', async () => {
    const { client, calls } = fakeClient()
    expect(await readMacService('/res', client, join(tempDir(), 'missing.plist'))).toEqual({ installed: false })
    expect(calls).toEqual([])
  })

  it('installed and this build’s own', async () => {
    const { client } = fakeClient([FIXTURE_BUILD])
    expect(await readMacService(resourcesFixture(), client, plist())).toEqual({ installed: true, version: '0.7.0', current: true })
  })

  it('installed by an earlier build: not current, until the next connection reinstalls it', async () => {
    const { client } = fakeClient(['0'.repeat(64)])
    expect(await readMacService(resourcesFixture(), client, plist())).toMatchObject({ installed: true, current: false })
  })

  it('installed but silent: installed, nothing more claimed', async () => {
    const client = { request: vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))) } as unknown as HelperClient
    expect(await readMacService(resourcesFixture(), client, plist())).toEqual({ installed: true })
  })
})

describe('removeMacService', () => {
  it('runs the bundled awg-helper uninstall behind the prompt', async () => {
    const run = vi.fn(async () => '')
    expect(await removeMacService('/Applications/SenAWG.app/Contents/Resources', run)).toBe('done')
    expect(run).toHaveBeenCalledWith(['/Applications/SenAWG.app/Contents/Resources/bin/awg-helper', 'uninstall'], expect.any(String))
  })

  it('a declined prompt is not a failure', async () => {
    const run = vi.fn(async (): Promise<string> => {
      throw new UserCancelledError()
    })
    expect(await removeMacService('/res', run)).toBe('cancelled')
  })

  it('a failure comes back with its message', async () => {
    const run = vi.fn(async (): Promise<string> => {
      throw new Error('launchctl: Boot-out failed')
    })
    await expect(removeMacService('/res', run)).rejects.toThrow('Boot-out failed')
  })
})
