import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tunnel } from '../src/shared/types'
import type { TunnelSecrets } from '../src/main/config/wgConfig'
import type { SenRequest, SenServer } from '../src/main/sen/client'
import { SenError } from '../src/main/sen/client'
import type { SenConfig, SenServerConfig } from '../src/main/sen/store'

const mem = vi.hoisted(() => ({
  tunnels: [] as Tunnel[],
  secrets: new Map<string, unknown>(),
  data: new Map<string, unknown>()
}))

vi.mock('../src/main/store', () => ({
  listTunnels: () => structuredClone(mem.tunnels),
  loadSecrets: (id: string) => structuredClone(mem.secrets.get(id) ?? null),
  saveSecrets: async (id: string, s: unknown) => {
    mem.secrets.set(id, structuredClone(s))
    return 'keyring'
  },
  removeSecrets: async (id: string) => void mem.secrets.delete(id),
  saveTunnel: async ({ tunnel, secrets }: { tunnel: Tunnel; secrets: unknown }) => {
    mem.tunnels.push(structuredClone(tunnel))
    mem.secrets.set(tunnel.id, structuredClone(secrets))
    return 'keyring'
  },
  updateTunnel: async (tunnel: Tunnel, secrets?: unknown) => {
    mem.tunnels = mem.tunnels.map((t) => (t.id === tunnel.id ? structuredClone(tunnel) : t))
    if (secrets) mem.secrets.set(tunnel.id, structuredClone(secrets))
  },
  removeTunnel: async (id: string) => {
    mem.tunnels = mem.tunnels.filter((t) => t.id !== id)
    mem.secrets.delete(id)
  },
  readData: (name: string, fallback: unknown) => structuredClone(mem.data.get(name) ?? fallback),
  writeData: (name: string, data: unknown) => void mem.data.set(name, structuredClone(data))
}))

const { SenManager } = await import('../src/main/sen/manager')
const { listSubscriptions } = await import('../src/main/sen/store')

// The link is the one tests/senLink.test.ts decodes: 203.0.113.7:40123, no TLS, named «Семья».
const LINK = 'sen://AQABBMsAcQecuwcHBwcHBwcHBwcHBwcHBwf9FyQ4WqDHW2T7eM1gL6HZkf3r92sTxY7XAurINen2GArQodC10LzRjNGPMVDMpw'

const key = (n: number): string => Buffer.alloc(32, n).toString('base64')

const server = (over: Partial<SenServerConfig> = {}): SenServerConfig => ({
  id: 0,
  name: 'VPN',
  endpoint: '203.0.113.7:47619',
  server_pub: key(2),
  psk: key(3),
  address: '10.9.0.5/32',
  dns: ['1.1.1.1', '1.0.0.1'],
  keepalive: '25',
  gen: '2',
  awg: { Jc: '4', Jmin: '10', Jmax: '50', S1: '60', S2: '100', H1: '1', H2: '2', H3: '3', H4: '4' },
  ...over
})

/** What forgetting's /sub/v1 does, as far as the client can tell. */
class FakeServer {
  rev = 'r1'
  rekey = false
  revoked = false
  full = false
  noDevicesRoute = false
  legacyRegister = false
  noPeek = false
  registeredCount = 0
  servers: SenServerConfig[] = [server()]
  calls: { method: string; path: string; ts: number; body: unknown; device?: number }[] = []
  registered: Record<string, unknown> | null = null

  config(): SenConfig {
    return { rev: this.rev, rekey: this.rekey, endpoints: ['203.0.113.7:40123'], servers: structuredClone(this.servers) }
  }

  handle = async (_s: SenServer, req: SenRequest): Promise<{ status: number; data: Record<string, unknown> }> => {
    const ts = req.nextTs?.() ?? 0
    await req.sign?.(`${req.method}\n${req.path}\n${ts}\nx`)
    this.calls.push({ method: req.method, path: req.path, ts, body: req.body, device: req.device })
    if (req.path === '/sub/v1/peek') {
      if (this.noPeek) throw new SenError('not_found')
      return { status: 200, data: { devices: this.registeredCount, device_limit: 3 } }
    }
    if (req.path === '/sub/v1/register') {
      if (this.full) throw new SenError('device_limit')
      this.registered = req.body as Record<string, unknown>
      this.registeredCount++
      const counts = this.legacyRegister ? {} : { devices: this.registeredCount, device_limit: 3 }
      return { status: 201, data: { device: 7, config: this.config(), ...counts } }
    }
    if (this.revoked) throw new SenError('unauthorized')
    if (req.method === 'POST' && req.path === '/sub/v1/rekey') {
      this.rekey = false
      this.rev = `${this.rev}k`
      return { status: 200, data: { config: this.config() } }
    }
    if (req.method === 'GET' && req.path === '/sub/v1/devices') {
      if (this.noDevicesRoute) throw new SenError('not_found')
      return {
        status: 200,
        data: {
          name: 'Семья',
          device_limit: 3,
          devices: [
            { id: 7, name: 'test-mac', platform: 'macos', version: '0.6.5', created_at: 1, last_seen: 2, current: true },
            { id: 9, name: 'phone', platform: 'android', version: '', created_at: 3, last_seen: null, current: false },
            { id: 'junk' }
          ]
        }
      }
    }
    if (req.method === 'DELETE') return { status: 200, data: { ok: true } }
    return { status: 200, data: { config: this.config() } }
  }

  count(path: string, method?: string): number {
    return this.calls.filter((c) => c.path === path && (!method || c.method === method)).length
  }
}

let srv: FakeServer
let clock: number
let active: Set<string>
let host: ReturnType<typeof makeHost>

function makeHost(platform: 'macos' | 'windows' | 'linux' = 'macos') {
  return {
    request: vi.fn(srv.handle),
    now: () => clock,
    version: '0.6.5',
    platform,
    deviceId: async () => 'dev-1',
    deviceName: () => 'test-mac',
    serviceSign: undefined as undefined | ((id: string, m: string) => Promise<Buffer>),
    tunnels: {
      isActive: (id: string) => active.has(id),
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async (id: string) => void active.delete(id)),
      reconnect: vi.fn(async () => {}),
      forget: vi.fn()
    },
    log: { info: vi.fn(), warn: vi.fn() },
    changed: vi.fn()
  }
}

const manager = (h = host) => new SenManager(h)
const tunnels = (): Tunnel[] => mem.tunnels
const secretsOf = (id: string): TunnelSecrets => mem.secrets.get(id) as TunnelSecrets

async function added(m = manager()): Promise<{ m: InstanceType<typeof SenManager>; tunnel: Tunnel; subId: string }> {
  const { tunnel } = await m.import(LINK)
  return { m, tunnel, subId: tunnel.source!.subId }
}

beforeEach(() => {
  mem.tunnels = []
  mem.secrets.clear()
  mem.data.clear()
  srv = new FakeServer()
  clock = 1_700_000_000_000
  active = new Set()
  host = makeHost()
})

describe('import', () => {
  it('registers with the public halves only and builds a tunnel that remembers its master key', async () => {
    const { tunnel, subId } = await added()

    const body = srv.registered!
    expect(body).toMatchObject({ device_id: 'dev-1', device_name: 'test-mac', platform: 'macos', version: '0.6.5' })
    expect(body.sub).toBe(Buffer.alloc(16, 7).toString('base64url'))
    // WireGuard's public key and the auth key's public half; the private ones are nowhere in the request.
    const wgPub = body.pub_key as string
    expect(Buffer.from(wgPub, 'base64')).toHaveLength(32)
    expect(Buffer.from(body.auth_pub as string, 'base64url')).toHaveLength(32)
    expect(JSON.stringify(body)).not.toContain(secretsOf(tunnel.id).privateKey)

    // A lone server is called by its own name, not the key's.
    expect(tunnel).toMatchObject({ name: 'VPN', endpoint: '203.0.113.7:47619', address: '10.9.0.5/32' })
    expect(tunnel.source).toEqual({ kind: 'sen', subId, serverId: 0 })
    expect(secretsOf(tunnel.id).presharedKey).toBe(key(3))
    // The auth key sits in the same secret store, under the id the Linux service accepts.
    expect(mem.secrets.has(`sen-${subId}`)).toBe(true)
    expect(listSubscriptions()[0]).toMatchObject({ id: subId, device: 7, appliedRev: 'r1', status: 'ok', tls: false })
    expect(JSON.stringify(listSubscriptions())).not.toContain(key(3))
  })

  it('refuses the same link twice: registering again would take the first copy\'s peer away', async () => {
    const { m } = await added()
    await expect(m.import(LINK)).rejects.toThrow(/уже добавлен/)
    expect(srv.count('/sub/v1/register')).toBe(1)
  })

  it('leaves nothing behind when the server refuses', async () => {
    srv.full = true
    await expect(manager().import(LINK)).rejects.toMatchObject({ code: 'device_limit' })
    expect(tunnels()).toEqual([])
    expect(mem.secrets.size).toBe(0)
    expect(listSubscriptions()).toEqual([])
  })

  it('gives the slot back when the answer is unusable', async () => {
    srv.servers = []
    await expect(manager().import(LINK)).rejects.toThrow(/нет серверов/)
    expect(srv.count('/sub/v1/device', 'DELETE')).toBe(1)
    expect(mem.secrets.size).toBe(0)
  })

  it('takes the count of slots from the register answer, without asking again', async () => {
    const first = await manager().import(LINK)
    expect(first.bindings).toEqual({ used: 1, limit: 3 })
    // Another computer with the same key: its own store, the server's count goes up.
    mem.tunnels = []
    mem.secrets.clear()
    mem.data.clear()
    expect((await new SenManager(makeHost()).import(LINK)).bindings).toEqual({ used: 2, limit: 3 })
    expect(srv.count('/sub/v1/devices')).toBe(0)
  })

  it('still imports when an older server does not say, just without the count', async () => {
    srv.legacyRegister = true
    expect((await manager().import(LINK)).bindings).toBeUndefined()
    expect(tunnels()).toHaveLength(1)
  })

  it('peeks at the slots of a pasted link without registering or signing anything', async () => {
    srv.registeredCount = 2
    expect(await manager().peek(LINK)).toEqual({ used: 2, limit: 3 })
    expect(srv.count('/sub/v1/register')).toBe(0)
    expect(srv.calls[0].ts).toBe(0)
    expect(mem.secrets.size).toBe(0)
    expect(tunnels()).toEqual([])
  })

  it('has no number to show from an older server or a dead one, and does not fail', async () => {
    srv.noPeek = true
    expect(await manager().peek(LINK)).toBeNull()
    host.request.mockRejectedValue(new SenError('network'))
    expect(await manager().peek(LINK)).toBeNull()
  })

  it('previews without sending anything', () => {
    expect(manager().preview(LINK)).toEqual({ name: 'Семья', address: '203.0.113.7:40123', tls: false })
    expect(host.request).not.toHaveBeenCalled()
  })
})

describe('refresh', () => {
  it('does nothing when the rev has not changed', async () => {
    const { m, tunnel } = await added()
    const before = structuredClone(mem.tunnels)
    expect(await m.refresh(tunnel.source!.subId)).toBe('same')
    expect(mem.tunnels).toEqual(before)
  })

  it('applies new parameters to an idle tunnel in place, keeping its id and its private key', async () => {
    const { m, tunnel, subId } = await added()
    const priv = secretsOf(tunnel.id).privateKey
    srv.rev = 'r2'
    srv.servers = [server({ awg: { Jc: '9', Jmin: '11', Jmax: '51', S1: '60', S2: '100', H1: '5', H2: '6', H3: '7', H4: '8' } })]

    expect(await m.refresh(subId)).toBe('applied')
    expect(tunnels()).toHaveLength(1)
    expect(tunnels()[0]).toMatchObject({ id: tunnel.id, awg: { jc: 9, h1: '5' } })
    expect(secretsOf(tunnel.id).privateKey).toBe(priv)
    expect(listSubscriptions()[0].appliedRev).toBe('r2')
  })

  it('follows a change of generation: the extra 3.1 keys arrive with the rest', async () => {
    const { m, subId } = await added()
    srv.rev = 'r2'
    srv.servers = [
      server({ gen: '3.1', keepalive: '25-35', awg: { ...server().awg, S3: '20', S4: '30', HeaderProtectionKey: key(9) } })
    ]
    await m.refresh(subId)
    expect(tunnels()[0].awg.extra).toMatchObject({ header_protection_key: key(9) })
    expect(tunnels()[0].keepalive).toBe(25)
  })

  it('leaves a running tunnel alone and says so; the settings apply once a connect is being made', async () => {
    const { m, tunnel, subId } = await added()
    active.add(tunnel.id)
    srv.rev = 'r2'
    srv.servers = [server({ endpoint: '198.51.100.1:1' })]

    expect(await m.refresh(subId)).toBe('pending')
    expect(tunnels()[0].endpoint).toBe('203.0.113.7:47619')
    expect(m.views()[0].pendingRev).toBe(true)

    expect(await m.refresh(subId, { force: true })).toBe('applied')
    expect(tunnels()[0].endpoint).toBe('198.51.100.1:1')
    expect(m.views()[0].pendingRev).toBe(false)
  })

  it('writes a changed preshared key with the private key it keeps', async () => {
    const { m, tunnel, subId } = await added()
    const priv = secretsOf(tunnel.id).privateKey
    srv.rev = 'r2'
    srv.servers = [server({ psk: key(4) })]
    await m.refresh(subId)
    expect(secretsOf(tunnel.id)).toEqual({ privateKey: priv, presharedKey: key(4) })
    expect(srv.count('/sub/v1/rekey')).toBe(0)
  })

  it('adds a card for a new server and drops the card of one that is gone', async () => {
    const { m, subId } = await added()
    srv.rev = 'r2'
    srv.servers = [server(), server({ id: 1, name: 'DE', endpoint: '198.51.100.9:443', address: '10.9.0.6/32' })]
    await m.refresh(subId)
    expect(tunnels().map((t) => t.source?.serverId)).toEqual([0, 1])
    expect(tunnels()[1].name).toBe('Семья · DE')

    srv.rev = 'r3'
    srv.servers = [server({ id: 1, name: 'DE', endpoint: '198.51.100.9:443', address: '10.9.0.6/32' })]
    await m.refresh(subId)
    expect(tunnels().map((t) => t.source?.serverId)).toEqual([1])
    expect(host.tunnels.forget).toHaveBeenCalledTimes(1)
  })

  it('does not pull a card out from under a running tunnel', async () => {
    const { m, tunnel, subId } = await added()
    srv.rev = 'r2'
    srv.servers = [server(), server({ id: 1, name: 'DE', endpoint: '198.51.100.9:443', address: '10.9.0.6/32' })]
    await m.refresh(subId)
    active.add(tunnel.id)
    srv.rev = 'r3'
    srv.servers = [server({ id: 1, name: 'DE', endpoint: '198.51.100.9:443', address: '10.9.0.6/32' })]
    await m.refresh(subId, { force: true })
    expect(tunnels().map((t) => t.source?.serverId)).toContain(0)
    active.clear()
    await m.refresh(subId)
    expect(tunnels().map((t) => t.source?.serverId)).toEqual([1])
  })

  it('never repeats a ts, even when the clock stands still: a repeated signature is refused as a replay', async () => {
    const { m, subId } = await added()
    await m.refresh(subId)
    await m.refresh(subId)
    const ts = srv.calls.map((c) => c.ts)
    expect(new Set(ts).size).toBe(ts.length)
    expect(ts).toEqual([...ts].sort((a, b) => a - b))
    expect(listSubscriptions()[0].lastTs).toBe(ts[ts.length - 1])
  })
})

describe('devices of the key', () => {
  it('lists them, marks this one, and drops what is not a device', async () => {
    const { m, subId } = await added()
    const res = await m.devices(subId)
    expect(res.limit).toBe(3)
    expect(res.devices).toEqual([
      { id: 7, name: 'test-mac', platform: 'macos', version: '0.6.5', createdAt: 1, lastSeen: 2, current: true },
      { id: 9, name: 'phone', platform: 'android', version: '', createdAt: 3, lastSeen: null, current: false }
    ])
  })

  it('says so plainly when the server is too old to know the route', async () => {
    const { m, subId } = await added()
    srv.noDevicesRoute = true
    await expect(m.devices(subId)).rejects.toThrow(/нужно обновить/)
    expect(m.views()[0].status).toBe('ok')
  })

  it('an unknown key is an error, not an empty list', async () => {
    await expect(manager().devices('nope')).rejects.toThrow(/не найден/)
  })
})

describe('rekey', () => {
  it('makes a new key pair when the server asks, sends only the public half, and reconnects a running tunnel', async () => {
    const { m, tunnel, subId } = await added()
    const before = secretsOf(tunnel.id).privateKey
    active.add(tunnel.id)
    srv.rekey = true

    expect(await m.refresh(subId)).toBe('rekeyed')
    const sent = srv.calls.find((c) => c.path === '/sub/v1/rekey')!.body as { pub_key: string }
    const after = secretsOf(tunnel.id).privateKey
    expect(after).not.toBe(before)
    expect(sent.pub_key).not.toBe(after)
    expect(Buffer.from(sent.pub_key, 'base64')).toHaveLength(32)
    expect(host.tunnels.reconnect).toHaveBeenCalledTimes(1)
  })

  it('does not reconnect from inside a connect that asked for the refresh itself', async () => {
    const { m, tunnel, subId } = await added()
    active.add(tunnel.id)
    srv.rekey = true
    await m.refresh(subId, { force: true })
    expect(host.tunnels.reconnect).not.toHaveBeenCalled()
  })
})

describe('when the server no longer knows the device', () => {
  it('marks the key revoked and keeps the tunnels; «Проверить снова» tries again', async () => {
    const { m, subId } = await added()
    srv.revoked = true
    expect(await m.refresh(subId)).toBe('failed')
    expect(m.views()[0].status).toBe('revoked')
    expect(tunnels()).toHaveLength(1)

    srv.revoked = false
    await m.refresh(subId)
    expect(m.views()[0].status).toBe('ok')
  })

  it('is offline when the network is what failed', async () => {
    const { m, subId } = await added()
    host.request.mockRejectedValue(new SenError('network'))
    await m.refresh(subId)
    expect(m.views()[0].status).toBe('offline')
    expect(tunnels()).toHaveLength(1)
  })

  it('says nothing about the server while a tunnel is up: the tunnel may be what blocks the request', async () => {
    const { m, tunnel, subId } = await added()
    active.add(tunnel.id)
    host.request.mockRejectedValue(new SenError('network'))
    await m.refresh(subId)
    expect(m.views()[0].status).toBe('ok')
  })
})

describe('around a connection', () => {
  it('fetches the newest settings before a connect, even for a tunnel that is up', async () => {
    const { m, tunnel } = await added()
    active.add(tunnel.id)
    srv.rev = 'r2'
    srv.servers = [server({ endpoint: '198.51.100.1:1' })]
    await m.beforeConnect(tunnel.id)
    expect(tunnels()[0].endpoint).toBe('198.51.100.1:1')
  })

  it('ignores a tunnel that is not a master key\'s', async () => {
    await manager().beforeConnect('somebody-else')
    expect(host.request).not.toHaveBeenCalled()
  })

  it('lets a connect go ahead on the saved settings when the server does not answer', async () => {
    const { m, tunnel } = await added()
    host.request.mockRejectedValue(new SenError('network'))
    await expect(m.beforeConnect(tunnel.id)).resolves.toBeUndefined()
  })

  it('reconnects a stale tunnel when the fetched settings differ, and at most every two minutes', async () => {
    const { m, tunnel } = await added()
    active.add(tunnel.id)
    srv.rev = 'r2'
    srv.servers = [server({ endpoint: '198.51.100.1:1' })]
    await m.onStale(tunnel.id)
    expect(host.tunnels.reconnect).toHaveBeenCalledTimes(1)

    srv.rev = 'r3'
    await m.onStale(tunnel.id)
    expect(host.tunnels.reconnect).toHaveBeenCalledTimes(1)
    clock += 121_000
    await m.onStale(tunnel.id)
    expect(host.tunnels.reconnect).toHaveBeenCalledTimes(2)
  })

  it('leaves a stale tunnel alone when nothing changed', async () => {
    const { m, tunnel } = await added()
    active.add(tunnel.id)
    await m.onStale(tunnel.id)
    expect(host.tunnels.reconnect).not.toHaveBeenCalled()
  })

  it('on Windows and Linux takes the tunnel down for the request the tunnel itself is blocking', async () => {
    host = makeHost('windows')
    const { m, tunnel } = await added(manager(host))
    active.add(tunnel.id)
    let reachable = false
    host.request.mockImplementation((s, r) => (reachable ? srv.handle(s, r) : Promise.reject(new SenError('network'))))
    host.tunnels.disconnect.mockImplementation(async (id) => {
      active.delete(id)
      reachable = true
    })
    srv.rev = 'r2'
    srv.servers = [server({ endpoint: '198.51.100.1:1' })]

    await m.onStale(tunnel.id)
    expect(host.tunnels.disconnect).toHaveBeenCalledWith(tunnel.id)
    expect(tunnels()[0].endpoint).toBe('198.51.100.1:1')
    expect(host.tunnels.connect).toHaveBeenCalledWith(tunnel.id)
  })

  it('on macOS a failed request is not blamed on the tunnel', async () => {
    const { m, tunnel } = await added()
    active.add(tunnel.id)
    host.request.mockRejectedValue(new SenError('network'))
    await m.onStale(tunnel.id)
    expect(host.tunnels.disconnect).not.toHaveBeenCalled()
  })
})

describe('removing', () => {
  it('unbinds the device and clears the servers, the keys and the record', async () => {
    const { m, subId } = await added()
    await m.removeSubscription(subId)
    expect(srv.count('/sub/v1/device', 'DELETE')).toBe(1)
    expect(tunnels()).toEqual([])
    expect(mem.secrets.size).toBe(0)
    expect(listSubscriptions()).toEqual([])
  })

  it('still removes locally when the server cannot be reached', async () => {
    const { m, subId } = await added()
    host.request.mockRejectedValue(new SenError('network'))
    await m.removeSubscription(subId)
    expect(listSubscriptions()).toEqual([])
    expect(host.log.warn).toHaveBeenCalled()
  })

  it('does not touch a key whose tunnel is running', async () => {
    const { m, tunnel, subId } = await added()
    active.add(tunnel.id)
    await expect(m.removeSubscription(subId)).rejects.toThrow(/отключите/)
    expect(listSubscriptions()).toHaveLength(1)
  })
})

describe('keys held by the Linux service', () => {
  it('signs through the service, and makes a new key pair when a preshared key changes (the old key cannot be read back)', async () => {
    host = makeHost('linux')
    const sign = vi.fn(async () => Buffer.alloc(64, 1))
    host.serviceSign = sign
    const { m, tunnel, subId } = await added(manager(host))
    // What the service's vault leaves the app with: a note, not the keys.
    mem.secrets.set(`sen-${subId}`, { privateKey: '', heldByService: true })
    mem.secrets.set(tunnel.id, { privateKey: '', heldByService: true })

    await m.refresh(subId)
    expect(sign).toHaveBeenCalledWith(`sen-${subId}`, expect.stringContaining('/sub/v1/config'))
    expect(srv.count('/sub/v1/rekey')).toBe(0)

    srv.rev = 'r2'
    srv.servers = [server({ psk: key(4) })]
    await m.refresh(subId)
    expect(srv.count('/sub/v1/rekey')).toBe(1)
    const written = secretsOf(tunnel.id)
    expect(written.privateKey).not.toBe('')
    expect(written.presharedKey).toBe(key(4))
  })

  it('leaves the keys of a service-held tunnel alone when only the parameters changed', async () => {
    host = makeHost('linux')
    host.serviceSign = async () => Buffer.alloc(64, 1)
    const { m, tunnel, subId } = await added(manager(host))
    mem.secrets.set(`sen-${subId}`, { privateKey: '', heldByService: true })
    mem.secrets.set(tunnel.id, { privateKey: '', heldByService: true })

    srv.rev = 'r2'
    srv.servers = [server({ awg: { ...server().awg, Jc: '9' } })]
    await m.refresh(subId)
    expect(srv.count('/sub/v1/rekey')).toBe(0)
    expect(tunnels()[0].awg.jc).toBe(9)
    expect(secretsOf(tunnel.id)).toEqual({ privateKey: '', heldByService: true })
  })
})
