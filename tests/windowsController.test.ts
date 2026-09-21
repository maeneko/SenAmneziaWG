import { describe, expect, it, vi } from 'vitest'
import type { Tunnel } from '../src/shared/types'
import type { HelperClient } from '../src/main/tunnel/windows/helperClient'
import { HelperError, type HelperRequest, type HelperResponse } from '../src/main/tunnel/windows/protocol'
import { WindowsHelperController } from '../src/main/tunnel/windowsHelperController'
import { helperNetProbes } from '../src/main/tunnel/windows/netProbes'
import { parseWgConfig } from '../src/main/config/wgConfig'

const KEY = Buffer.alloc(32, 1).toString('base64')
const KEY_B = Buffer.alloc(32, 2).toString('base64')
const INI = (extra = '') => `[Interface]\nPrivateKey = ${KEY}\nAddress = 10.8.1.2/32, fd00::2/128\nDNS = 1.1.1.1, 1.0.0.1\nJc = 4\nJmin = 10\nJmax = 50\nS1 = 60\nS2 = 100\nH1 = 11\nH2 = 22\nH3 = 33\nH4 = 44\n${extra}\n[Peer]\nPublicKey = ${KEY_B}\nAllowedIPs = 0.0.0.0/0\nEndpoint = 203.0.113.7:51820\n`
const { tunnel, secrets } = parseWgConfig(INI(), { name: 'Германия' })
const tunnel31 = parseWgConfig(INI('RandomTrailers = on\n'), { name: 'Финляндия' }).tunnel

const HELLO: HelperResponse = { ok: true, protocol: 1, helper: '0.1.0', awgGo: 'v3.1.20260828' }

/** A scripted helper: answers by op, records every request. */
function fakeClient(answers: Partial<Record<HelperRequest['op'], HelperResponse | Error>> = {}) {
  const calls: HelperRequest[] = []
  const request = vi.fn(async (req: HelperRequest): Promise<HelperResponse> => {
    calls.push(req)
    const a = answers[req.op] ?? (req.op === 'hello' ? HELLO : { ok: true })
    if (a instanceof Error) throw a
    return a
  })
  return { client: { request } as unknown as HelperClient, calls, request }
}

describe('WindowsHelperController.up', () => {
  it('sends the tunnel as a .conf, its id and name, and returns the active tunnel', async () => {
    const { client, calls } = fakeClient({ up: { ok: true, iface: 'SenAWG', endpointIp: '203.0.113.7' } })
    const active = await new WindowsHelperController(client).up(tunnel, secrets)
    const up = calls.find((c) => c.op === 'up')!
    expect(up).toMatchObject({ id: tunnel.id, name: 'Германия', replace: false })
    expect(up.conf).toContain(`PrivateKey = ${KEY}`)
    expect(up.conf).toContain('Endpoint = 203.0.113.7:51820')
    expect(active).toEqual({ id: tunnel.id, iface: 'SenAWG', endpointIp: '203.0.113.7', localIp: '10.8.1.2' })
  })

  it('forwards replace, so a server switch is one operation', async () => {
    const { client, calls } = fakeClient()
    await new WindowsHelperController(client).up(tunnel, secrets, true)
    expect(calls.find((c) => c.op === 'up')?.replace).toBe(true)
  })

  it('uses the DNS from Settings when there is one, and reports which', async () => {
    const { client, calls } = fakeClient()
    const log = vi.fn()
    await new WindowsHelperController(client, log, () => ['9.9.9.9']).up(tunnel, secrets)
    expect(calls.find((c) => c.op === 'up')?.conf).toContain('DNS = 9.9.9.9')
    expect(log).toHaveBeenCalledWith('info', 'DNS: 9.9.9.9')
  })

  it('says so when no DNS is set', async () => {
    const { client } = fakeClient()
    const log = vi.fn()
    await new WindowsHelperController(client, log, () => []).up(tunnel, secrets)
    expect(log).toHaveBeenCalledWith('info', expect.stringMatching(/DNS не задан/))
  })

  it('never writes the private key to the journal', async () => {
    const { client } = fakeClient()
    const log = vi.fn()
    await new WindowsHelperController(client, log).up(tunnel, secrets)
    expect(JSON.stringify(log.mock.calls)).not.toContain(KEY)
  })

  it('refuses, before starting anything, a config the built-in daemon is too old for', async () => {
    const { client, calls } = fakeClient({ hello: { ...HELLO, awgGo: 'v3.0.20250101' } })
    await expect(new WindowsHelperController(client).up(tunnel31, secrets)).rejects.toThrow(/не поддерживает/)
    expect(calls.map((c) => c.op)).toEqual(['hello'])
  })

  it('lets a config through when the daemon is new enough', async () => {
    const { client, calls } = fakeClient()
    await new WindowsHelperController(client).up(tunnel31, secrets)
    expect(calls.some((c) => c.op === 'up')).toBe(true)
  })

  it('lets a failure of the service reach the caller with its own message', async () => {
    const { client } = fakeClient({ up: new HelperError('Туннель не запустился: нет wintun.dll', 'SERVICE') })
    await expect(new WindowsHelperController(client).up(tunnel, secrets)).rejects.toThrow('Туннель не запустился: нет wintun.dll')
  })
})

describe('WindowsHelperController.hello', () => {
  it('asks once', async () => {
    const { client, calls } = fakeClient()
    const c = new WindowsHelperController(client)
    await c.up(tunnel, secrets)
    await c.up(tunnel, secrets)
    expect(calls.filter((x) => x.op === 'hello')).toHaveLength(1)
  })

  it('rejects a service that speaks another protocol, and asks again next time', async () => {
    const { client, request } = fakeClient({ hello: { ...HELLO, protocol: 2 } })
    const c = new WindowsHelperController(client)
    await expect(c.hello()).rejects.toThrow(/другой версии/)
    request.mockClear()
    await expect(c.hello()).rejects.toThrow()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('does not remember a service that was not running yet', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new HelperError('Служба SenAWG не запущена', 'NOT_RUNNING'))
      .mockResolvedValue(HELLO)
    const c = new WindowsHelperController({ request } as unknown as HelperClient)
    await expect(c.hello()).rejects.toThrow(/не запущена/)
    await expect(c.hello()).resolves.toMatchObject({ helper: '0.1.0' })
  })
})

describe('WindowsHelperController state', () => {
  it('stats are parsed from the daemon answer the service relays', async () => {
    const uapi = 'public_key=aa\nrx_bytes=1500\ntx_bytes=900\nlast_handshake_time_sec=1758268800\nerrno=0\n\n'
    const { client } = fakeClient({ stats: { ok: true, uapi } })
    expect(await new WindowsHelperController(client).stats({ id: 'x', iface: 'SenAWG' })).toEqual({
      rxBytes: 1500,
      txBytes: 900,
      lastHandshakeSec: 1758268800
    })
  })

  it('a dead tunnel is an error, which the manager reports as an unexpected stop', async () => {
    const { client } = fakeClient({ stats: new HelperError('Туннель остановился неожиданно', 'TUNNEL_DEAD') })
    await expect(new WindowsHelperController(client).stats({ id: 'x', iface: 'SenAWG' })).rejects.toThrow(/остановился/)
  })

  it('recover finds the running tunnel, with the time it started', async () => {
    const { client } = fakeClient({ status: { ok: true, active: { id: 't1', iface: 'SenAWG', startedAt: 1758268800000 } } })
    expect(await new WindowsHelperController(client).recover()).toEqual({ id: 't1', iface: 'SenAWG', startedAt: 1758268800000 })
  })

  it('recover is null when nothing runs', async () => {
    const { client } = fakeClient({ status: { ok: true } })
    expect(await new WindowsHelperController(client).recover()).toBeNull()
  })

  it('hasStaleState mirrors the service', async () => {
    expect(await new WindowsHelperController(fakeClient({ status: { ok: true, stale: true } }).client).hasStaleState()).toBe(true)
    expect(await new WindowsHelperController(fakeClient({ status: { ok: true } }).client).hasStaleState()).toBe(false)
  })

  it('down and cleanup send their verbs', async () => {
    const { client, calls } = fakeClient()
    const c = new WindowsHelperController(client)
    await c.down({ id: 'x', iface: 'SenAWG' })
    await c.cleanup()
    expect(calls.map((x) => x.op)).toEqual(['down', 'cleanup'])
  })

  it('has no packet capture', () => {
    expect((new WindowsHelperController(fakeClient().client) as { readCapture?: unknown }).readCapture).toBeUndefined()
  })
})

describe('helperNetProbes', () => {
  it('asks the service for the route to the address it is given', async () => {
    const { client, calls } = fakeClient({ netinfo: { ok: true, routeIface: 'SenAWG' } })
    expect(await helperNetProbes(client).routeInterface('1.1.1.1')).toBe('SenAWG')
    expect(calls[0]).toEqual({ op: 'netinfo', target: '1.1.1.1' })
  })

  it('no route is null', async () => {
    expect(await helperNetProbes(fakeClient({ netinfo: { ok: true } }).client).routeInterface('1.1.1.1')).toBeNull()
  })

  it('maps the resolver, always reachable (Windows has no such flag)', async () => {
    const { client } = fakeClient({ netinfo: { ok: true, resolver: { iface: 'Wi-Fi', nameservers: ['192.168.1.1'] } } })
    expect(await helperNetProbes(client).primaryResolver()).toEqual({ iface: 'Wi-Fi', nameservers: ['192.168.1.1'], reachable: true })
  })

  it('no resolver is null', async () => {
    expect(await helperNetProbes(fakeClient({ netinfo: { ok: true } }).client).primaryResolver()).toBeNull()
  })
})

// keep the import used even if the fixtures above change
export type _T = Tunnel
