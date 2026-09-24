import { describe, expect, it, vi } from 'vitest'
import type { HelperClient } from '../src/main/tunnel/windows/helperClient'
import { HelperError, type HelperRequest, type HelperResponse } from '../src/main/tunnel/windows/protocol'
import { LinuxHelperController } from '../src/main/tunnel/linuxHelperController'
import type { TunnelController } from '../src/main/tunnel/TunnelController'
import { parseWgConfig } from '../src/main/config/wgConfig'

const KEY = Buffer.alloc(32, 1).toString('base64')
const KEY_B = Buffer.alloc(32, 2).toString('base64')
const INI = (extra = '') => `[Interface]\nPrivateKey = ${KEY}\nAddress = 10.8.1.2/32, fd00::2/128\nDNS = 1.1.1.1, 1.0.0.1\nJc = 4\nJmin = 10\nJmax = 50\nS1 = 60\nS2 = 100\nH1 = 11\nH2 = 22\nH3 = 33\nH4 = 44\n${extra}\n[Peer]\nPublicKey = ${KEY_B}\nAllowedIPs = 0.0.0.0/0\nEndpoint = 203.0.113.7:51820\n`
const { tunnel, secrets } = parseWgConfig(INI(), { name: 'Германия' })
const tunnel31 = parseWgConfig(INI('RandomTrailers = on\n'), { name: 'Финляндия' }).tunnel

const HELLO: HelperResponse = { ok: true, protocol: 1, helper: '0.1.0', awgGo: 'v3.1.20260828' }

/** A scripted helper: answers by op, records every request — same shape as windowsController.test.ts's,
 * since both controllers talk to the same JSON protocol (helper/internal/proto). */
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

describe('LinuxHelperController.up', () => {
  it('sends the UAPI body (like macOS) plus address/mtu/dns (which the body itself omits)', async () => {
    const { client, calls } = fakeClient({ up: { ok: true, iface: 'senawg0', endpointIp: '203.0.113.7' } })
    const active = await new LinuxHelperController(client).up(tunnel, secrets)
    const up = calls.find((c) => c.op === 'up')!
    expect(up).toMatchObject({ id: tunnel.id, name: 'Германия', replace: false, mtu: 1280 })
    expect(up.conf).toMatch(/^set=1\n/)
    expect(up.conf).toContain(`private_key=${Buffer.from(KEY, 'base64').toString('hex')}`)
    expect(up.conf).toContain('endpoint=203.0.113.7:51820')
    expect(up.address).toEqual(['10.8.1.2/32', 'fd00::2/128'])
    expect(active).toEqual({ id: tunnel.id, iface: 'senawg0', endpointIp: '203.0.113.7', localIp: '10.8.1.2' })
  })

  it('keys held by the service: sends the body without them and asks the service to add its own', async () => {
    const { client, calls } = fakeClient()
    const withPsk = parseWgConfig(INI().replace('Endpoint', `PresharedKey = ${KEY_B}\nEndpoint`), { name: 'П' }).tunnel
    await new LinuxHelperController(client).up(withPsk, { privateKey: '', heldByService: true })
    const up = calls.find((c) => c.op === 'up')!
    expect(up.vault).toBe(true)
    expect(up.conf).toMatch(/^set=1\nreplace_peers=true\n/)
    expect(up.conf).not.toMatch(/private_key=|preshared_key=/)
    expect(up.conf).toContain(`public_key=${Buffer.from(KEY_B, 'base64').toString('hex')}`)
  })

  it('keys the app holds: no vault flag', async () => {
    const { client, calls } = fakeClient()
    await new LinuxHelperController(client).up(tunnel, secrets)
    expect(calls.find((c) => c.op === 'up')?.vault).toBeUndefined()
  })

  it('forwards replace, so a server switch is one operation', async () => {
    const { client, calls } = fakeClient()
    await new LinuxHelperController(client).up(tunnel, secrets, true)
    expect(calls.find((c) => c.op === 'up')?.replace).toBe(true)
  })

  it('uses the DNS from Settings when there is one, and reports which', async () => {
    const { client, calls } = fakeClient()
    const log = vi.fn()
    await new LinuxHelperController(client, log, () => ['9.9.9.9']).up(tunnel, secrets)
    expect(calls.find((c) => c.op === 'up')?.dns).toEqual(['9.9.9.9'])
    expect(log).toHaveBeenCalledWith('info', 'DNS: 9.9.9.9')
  })

  it('says so when no DNS is set', async () => {
    const { client } = fakeClient()
    const log = vi.fn()
    await new LinuxHelperController(client, log, () => []).up(tunnel, secrets)
    expect(log).toHaveBeenCalledWith('info', expect.stringMatching(/DNS не задан/))
  })

  it('never writes the private key to the journal', async () => {
    const { client } = fakeClient()
    const log = vi.fn()
    await new LinuxHelperController(client, log).up(tunnel, secrets)
    expect(JSON.stringify(log.mock.calls)).not.toContain(KEY)
  })

  it('refuses, before starting anything, a config the daemon in the service is too old for', async () => {
    const { client, calls } = fakeClient({ hello: { ...HELLO, awgGo: 'v3.0.20250101' } })
    await expect(new LinuxHelperController(client).up(tunnel31, secrets)).rejects.toThrow(/не поддерживает/)
    expect(calls.map((c) => c.op)).toEqual(['hello'])
  })

  it('lets a config through when the daemon is new enough', async () => {
    const { client, calls } = fakeClient()
    await new LinuxHelperController(client).up(tunnel31, secrets)
    expect(calls.some((c) => c.op === 'up')).toBe(true)
  })

  it('lets a failure of the service reach the caller with its own message', async () => {
    const { client } = fakeClient({ up: new HelperError('Туннель уже активен', 'BUSY') })
    await expect(new LinuxHelperController(client).up(tunnel, secrets)).rejects.toThrow('Туннель уже активен')
  })
})

describe('LinuxHelperController: the rest of TunnelController', () => {
  it('down sends down', async () => {
    const { client, calls } = fakeClient()
    await new LinuxHelperController(client).down({ id: 'x', iface: 'senawg0' })
    expect(calls.map((c) => c.op)).toEqual(['down'])
  })

  it('stats parses the service’s uapi text', async () => {
    const { client } = fakeClient({ stats: { ok: true, uapi: 'public_key=ab\nrx_bytes=10\ntx_bytes=20\nlast_handshake_time_sec=5\n' } })
    const stats = await new LinuxHelperController(client).stats({ id: 'x', iface: 'senawg0' })
    expect(stats).toMatchObject({ rxBytes: 10, txBytes: 20 })
  })

  it('recover reflects an active tunnel from status', async () => {
    const { client } = fakeClient({ status: { ok: true, active: { id: 'x', iface: 'senawg0', startedAt: 123 } } })
    await expect(new LinuxHelperController(client).recover()).resolves.toEqual({ id: 'x', iface: 'senawg0', startedAt: 123 })
  })

  it('recover is null with nothing active', async () => {
    const { client } = fakeClient({ status: { ok: true } })
    await expect(new LinuxHelperController(client).recover()).resolves.toBeNull()
  })

  it('hasStaleState reads status.stale', async () => {
    const { client } = fakeClient({ status: { ok: true, stale: true } })
    await expect(new LinuxHelperController(client).hasStaleState()).resolves.toBe(true)
  })

  it('cleanup sends cleanup', async () => {
    const { client, calls } = fakeClient()
    await new LinuxHelperController(client).cleanup()
    expect(calls.map((c) => c.op)).toEqual(['cleanup'])
  })

  it('has no packet capture, like Windows', () => {
    const controller: TunnelController = new LinuxHelperController(fakeClient().client)
    expect(controller.readCapture).toBeUndefined()
  })
})
