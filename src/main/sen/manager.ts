import crypto from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import type { KeyBindings, KeyDevices, MasterKeyPreview, SubscriptionView, Tunnel } from '../../shared/types'
import {
  type SenAddr,
  addrString,
  decodeSenLink,
  generateAuthKey,
  generateWgKeyPair,
  privateKeyFromSeed
} from '../config/senLink'
import { VpnLinkError } from '../config/vpnLink'
import { listTunnels, loadSecrets, removeSecrets, removeTunnel, saveSecrets, saveTunnel, updateTunnel } from '../store'
import { type SenResponse, type SenServer, type SenRequest, SenError } from './client'
import { configToParsed, parseSenConfig } from './config'
import { type SenConfig, type SenServerConfig, type Subscription, authKeyId, deleteSubscription, getSubscription, listSubscriptions, newSubscriptionId, saveSubscription } from './store'

/** How often every master key is asked for its settings, besides at start and before each connect. */
export const POLL_MS = 15 * 60_000
const FIRST_POLL_MS = 5_000
/** A pasted link is peeked at while the person watches: better no number than a long wait for one. */
const PEEK_MS = 4_000
/** Before a connect the answer is worth having, but not worth keeping the person waiting for. */
const BEFORE_CONNECT_MS = 5_000
/** A dead tunnel is fixed by fetching the settings, but not by hammering the server. */
const STALE_RETRY_MS = 2 * 60_000

/** What the manager needs from the rest of the app; everything else it reaches through the stores. */
export interface SenHost {
  request: (server: SenServer, req: SenRequest) => Promise<SenResponse>
  now: () => number
  version: string
  platform: 'macos' | 'windows' | 'linux'
  deviceId: (signPub: Buffer) => Promise<string>
  deviceName: () => string | Promise<string>
  /** Linux with the keys in the service: it signs, the auth key never comes back to the app. */
  serviceSign?: (id: string, message: string) => Promise<Buffer>
  tunnels: {
    isActive: (id: string) => boolean
    connect: (id: string) => Promise<void>
    disconnect: (id: string) => Promise<void>
    reconnect: () => Promise<void>
    forget: (id: string) => void
  }
  log: { info: (m: string) => void; warn: (m: string) => void }
  /** The list or a status changed: push the state to the window. */
  changed: () => void
}

/** `rekeyed`: applied, and the device key was replaced too — a running tunnel of it cannot go on. */
type Outcome = 'same' | 'pending' | 'applied' | 'rekeyed'

const sha = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex')
const b64 = (b: Buffer): string => b.toString('base64')
/** A lone server is called by its own name; among several, each is marked with the key's name too. */
const tunnelName = (keyName: string, servers: SenServerConfig[], s: SenServerConfig): string =>
  servers.length > 1 ? `${keyName} · ${s.name}` : s.name

function parseHostPort(text: string): SenAddr | null {
  const i = text.lastIndexOf(':')
  const port = Number(text.slice(i + 1))
  const host = text.slice(0, i).replace(/^\[|\]$/g, '')
  return i > 0 && host && Number.isInteger(port) && port > 0 && port < 65536 ? { host, port } : null
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([p, sleep(ms, undefined, { ref: false })])

export class SenManager {
  /** Master keys whose server has newer settings than a running tunnel uses (applied on the next connect). */
  private readonly pending = new Set<string>()
  /** One exchange with a given master key at a time: a refresh must not interleave with a rekey. */
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly lastStaleTry = new Map<string, number>()
  private timers: NodeJS.Timeout[] = []

  constructor(private readonly host: SenHost) {}

  // ── For the window ──────────────────────────────────────────────────────

  views(): SubscriptionView[] {
    return listSubscriptions().map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      pendingRev: this.pending.has(s.id),
      plain: !s.tls,
      checkedAt: s.checkedAt
    }))
  }

  /** Reads a link and says what is in it; nothing is sent, so no device slot is spent. */
  preview(link: string): MasterKeyPreview {
    const l = decodeSenLink(link)
    return { name: l.name, address: addrString(l.addrs[0]), tls: l.tls }
  }

  // ── Adding and removing ─────────────────────────────────────────────────

  /**
   * How many of the key's slots are taken, asked before anything is registered — for the window that shows a
   * pasted link. Null when the server cannot say (an older one) or does not answer soon: the window then has
   * nothing to show, and the key can still be added.
   */
  async peek(link: string): Promise<KeyBindings | null> {
    const l = decodeSenLink(link)
    try {
      const res = await this.host.request(
        { addrs: l.addrs, tls: l.tls, tlsPin: l.tlsPin, signPub: l.signPub },
        { method: 'POST', path: '/sub/v1/peek', body: { sub: l.secret.toString('base64url') }, version: this.host.version, timeoutMs: PEEK_MS }
      )
      const { devices, device_limit: limit } = res.data
      return Number.isInteger(devices) && Number.isInteger(limit) && (limit as number) > 0
        ? { used: devices as number, limit: limit as number }
        : null
    } catch {
      return null
    }
  }

  /**
   * Registers this computer with the master key: it makes its own WireGuard and auth keys, sends only the
   * public halves, and gets the servers back. Returns the first one.
   */
  async import(link: string): Promise<{ tunnel: Tunnel; bindings?: KeyBindings }> {
    const l = decodeSenLink(link)
    const linkId = sha(Buffer.concat([l.signPub, l.secret]))
    if (listSubscriptions().some((s) => s.linkId === linkId)) throw new VpnLinkError('Этот мастер-ключ уже добавлен')

    const id = newSubscriptionId()
    const wg = generateWgKeyPair()
    const auth = generateAuthKey()
    // Before anything is sent: no place to keep the key means no point in taking a slot.
    await saveSecrets(authKeyId(id), { privateKey: b64(auth.seed) })

    const server: SenServer = { addrs: l.addrs, tls: l.tls, tlsPin: l.tlsPin, signPub: l.signPub }
    const authKey = privateKeyFromSeed(auth.seed)
    let ts = 0
    let device = -1
    const saved: string[] = []
    try {
      const res = await this.host.request(server, {
        method: 'POST',
        path: '/sub/v1/register',
        body: {
          sub: l.secret.toString('base64url'),
          device_id: await this.host.deviceId(l.signPub),
          device_name: await this.host.deviceName(),
          platform: this.host.platform,
          pub_key: wg.publicKey,
          auth_pub: auth.pub.toString('base64url'),
          version: this.host.version
        },
        sign: async (m) => crypto.sign(null, Buffer.from(m, 'utf8'), authKey),
        nextTs: () => (ts = Math.max(Math.floor(this.host.now() / 1000), ts + 1)),
        version: this.host.version
      })
      if (!Number.isInteger(res.data.device)) throw new VpnLinkError('Сервер подписки не назвал номер устройства')
      device = res.data.device as number
      const cfg = parseSenConfig(res.data.config)
      if (!cfg.servers.length) throw new VpnLinkError('У этого мастер-ключа пока нет серверов')

      const name = l.name || cfg.servers[0].name
      const tunnels: Subscription['tunnels'] = {}
      for (const s of cfg.servers) {
        const parsed = configToParsed(s, wg.privateKey, tunnelName(name, cfg.servers, s))
        parsed.tunnel.source = { kind: 'sen', subId: id, serverId: s.id }
        await saveTunnel(parsed)
        saved.push(parsed.tunnel.id)
        tunnels[s.id] = { tunnelId: parsed.tunnel.id, pskHash: sha(s.psk) }
      }
      saveSubscription({
        id,
        linkId,
        name,
        addrs: l.addrs,
        tls: l.tls,
        tlsPin: l.tlsPin ? b64(l.tlsPin) : undefined,
        signPub: b64(l.signPub),
        device,
        lastTs: ts,
        appliedRev: cfg.rev,
        endpoints: cfg.endpoints,
        status: 'ok',
        checkedAt: this.host.now(),
        tunnels
      })
      this.host.log.info(`Добавлен мастер-ключ «${name}»: серверов ${cfg.servers.length}, устройство ${device}`)
      const tunnel = listTunnels().find((t) => t.id === saved[0]) as Tunnel
      // The register answer says how many slots are taken, for the window to show the one just used. A server
      // that does not say (an older one) is not a failure: the window just has no bar to show.
      const used = res.data.devices
      const limit = res.data.device_limit
      const bindings: KeyBindings | undefined =
        Number.isInteger(used) && Number.isInteger(limit) && (limit as number) > 0
          ? { used: used as number, limit: limit as number }
          : undefined
      return { tunnel, bindings }
    } catch (err) {
      // Whatever was half done comes back out, and the slot the server may have given goes back too.
      for (const t of saved) await removeTunnel(t).catch(() => {})
      await removeSecrets(authKeyId(id)).catch(() => {})
      if (device >= 0) {
        await withTimeout(
          this.host
            .request(server, {
              method: 'DELETE',
              path: '/sub/v1/device',
              device,
              sign: async (m) => crypto.sign(null, Buffer.from(m, 'utf8'), authKey),
              nextTs: () => (ts = Math.max(Math.floor(this.host.now() / 1000), ts + 1)),
              version: this.host.version
            })
            .catch(() => {}),
          BEFORE_CONNECT_MS
        )
      }
      throw err
    }
  }

  /** «Отвязать»: the server forgets this device (best effort), and the servers and keys leave this computer. */
  async removeSubscription(id: string): Promise<void> {
    const sub = getSubscription(id)
    if (!sub) return
    if (Object.values(sub.tunnels).some((t) => this.host.tunnels.isActive(t.tunnelId))) {
      throw new Error('Сначала отключите туннель')
    }
    await this.locked(id, async () => {
      if (sub.status !== 'revoked') {
        const released = await withTimeout(
          this.call(sub, 'DELETE', '/sub/v1/device').then(
            () => true,
            () => false
          ),
          BEFORE_CONNECT_MS
        )
        if (!released) this.host.log.warn(`Сервер не подтвердил отвязку устройства «${sub.name}» — слот можно освободить в панели`)
      }
      for (const t of Object.values(sub.tunnels)) {
        await removeTunnel(t.tunnelId).catch(() => {})
        this.host.tunnels.forget(t.tunnelId)
      }
      await removeSecrets(authKeyId(id)).catch(() => {})
      deleteSubscription(id)
      this.pending.delete(id)
      this.host.log.info(`Удалён мастер-ключ «${sub.name}»`)
    })
    this.host.changed()
  }

  /** «Ключ»: who else is bound to this master key. Read-only; a device can only unbind itself. */
  async devices(id: string): Promise<KeyDevices> {
    const sub = getSubscription(id)
    if (!sub) throw new Error('Мастер-ключ не найден')
    let data: Record<string, unknown>
    try {
      data = (await this.locked(id, () => this.call(sub, 'GET', '/sub/v1/devices'))).data
    } catch (err) {
      if (err instanceof SenError && err.code === 'unauthorized') this.failed(sub, err)
      // A server from before the tab has no such route, and says «not found» to it.
      if (err instanceof SenError && err.code === 'not_found') {
        throw new Error('Сервер этого ключа пока не отдаёт список устройств — его нужно обновить')
      }
      throw err
    }
    if (!Array.isArray(data.devices)) throw new SenError('bad_response', 'devices')
    const num = (v: unknown): number | null => (Number.isFinite(v) ? (v as number) : null)
    const devices = (data.devices as unknown[]).flatMap((d) => {
      const r = d as Record<string, unknown>
      const dev = num(r?.id)
      if (dev === null) return []
      return [{
        id: dev,
        name: typeof r.name === 'string' ? r.name : '',
        platform: typeof r.platform === 'string' ? r.platform : '',
        version: typeof r.version === 'string' ? r.version : '',
        createdAt: num(r.created_at) ?? 0,
        lastSeen: num(r.last_seen),
        // The server says who asked; the device number this computer holds is the same fact, twice told.
        current: r.current === true || dev === sub.device
      }]
    })
    this.host.changed()
    return { limit: num(data.device_limit) ?? devices.length, devices }
  }

  // ── Keeping the settings current ────────────────────────────────────────

  /**
   * Asks the server for the settings and applies what changed. `force`: a connection is about to be made
   * (or remade) anyway, so a running tunnel of this key may be updated too. Never throws: the outcome is
   * the subscription's status.
   */
  async refresh(id: string, opts: { force?: boolean } = {}): Promise<Outcome | 'failed'> {
    const result = await this.locked(id, async (): Promise<Outcome | 'failed'> => {
      const sub = getSubscription(id)
      if (!sub) return 'failed'
      try {
        const res = await this.call(sub, 'GET', '/sub/v1/config')
        const outcome = await this.apply(id, parseSenConfig(res.data.config), opts.force === true)
        this.patch(id, { status: 'ok', checkedAt: this.host.now() })
        return outcome
      } catch (err) {
        this.failed(sub, err)
        return 'failed'
      }
    })
    this.host.changed()
    // Outside the lock: reconnecting comes back here for the settings (beforeConnect). A forced refresh is
    // part of a connect that is being made anyway, and leaves that to its caller.
    if (result === 'rekeyed' && !opts.force) await this.host.tunnels.reconnect().catch(() => {})
    return result
  }

  private failed(sub: Subscription, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    if (err instanceof SenError && (err.code === 'unauthorized' || err.code === 'not_found')) {
      this.patch(sub.id, { status: 'revoked', checkedAt: this.host.now() })
      this.host.log.warn(
        `Мастер-ключ «${sub.name}»: сервер не узнаёт это устройство (отозвано в панели, а если нет — проверьте время на компьютере)`
      )
      return
    }
    // A tunnel that is up may well be cutting this very request off (Windows blocks all but the tunnel),
    // so a failure then says nothing about the server.
    const running = Object.values(sub.tunnels).some((t) => this.host.tunnels.isActive(t.tunnelId))
    if (!running) this.patch(sub.id, { status: 'offline' })
    this.host.log.warn(`Мастер-ключ «${sub.name}»: не удалось получить настройки — ${message}`)
  }

  /**
   * Brings the tunnels of the key to the config the server just sent. A running tunnel is left alone when
   * the handshake is alive: the person keeps their connection, and the new settings wait for the next one.
   */
  private async apply(id: string, incoming: SenConfig, force: boolean): Promise<Outcome> {
    let cfg = incoming
    const sub = getSubscription(id) as Subscription
    const own = (serverId: number) => sub.tunnels[serverId]
    const running = Object.values(sub.tunnels).some((t) => this.host.tunnels.isActive(t.tunnelId))

    const known = new Set(cfg.servers.map((s) => s.id))
    const vanished = Object.keys(sub.tunnels).map(Number).filter((n) => !known.has(n))

    if (cfg.rev === sub.appliedRev && !cfg.rekey) {
      await this.sweep(id, vanished)
      this.patch(id, { endpoints: cfg.endpoints })
      this.pending.delete(id)
      return 'same'
    }
    // A rekey cannot wait: the server has asked for a new key, and holding on to the old one helps no one.
    if (running && !force && !cfg.rekey) {
      this.pending.add(id)
      this.patch(id, { endpoints: cfg.endpoints })
      this.host.log.info(`Мастер-ключ «${sub.name}»: сервер обновил настройки — они применятся при следующем подключении`)
      return 'pending'
    }

    const first = Object.values(sub.tunnels)[0]
    const current = first ? loadSecrets(first.tunnelId) : null
    let privateKey = current && !current.heldByService ? current.privateKey : null
    const pskChanged = cfg.servers.some((s) => !own(s.id) || own(s.id).pskHash !== sha(s.psk))

    let rekeyed = false
    // The keys held by the service never come back, so a preshared key or a new server (both need the
    // private key written alongside) is a reason to make a new pair, as the server's own rekey allows.
    if (cfg.rekey || (pskChanged && privateKey === null)) {
      const pair = generateWgKeyPair()
      const res = await this.call(sub, 'POST', '/sub/v1/rekey', { pub_key: pair.publicKey })
      cfg = parseSenConfig(res.data.config)
      privateKey = pair.privateKey
      rekeyed = true
    }

    const tunnels: Subscription['tunnels'] = {}
    for (const s of cfg.servers) {
      const existing = own(s.id)
      // With no private key in hand the tunnel is only rebuilt for its parameters; its keys are not touched.
      const parsed = configToParsed(s, privateKey ?? crypto.randomBytes(32).toString('base64'), tunnelName(sub.name, cfg.servers, s))
      parsed.tunnel.source = { kind: 'sen', subId: id, serverId: s.id }
      const pskHash = sha(s.psk)
      if (existing) {
        parsed.tunnel.id = existing.tunnelId
        const keysChanged = rekeyed || existing.pskHash !== pskHash
        await updateTunnel(parsed.tunnel, keysChanged ? parsed.secrets : undefined)
      } else {
        await saveTunnel(parsed)
      }
      tunnels[s.id] = { tunnelId: parsed.tunnel.id, pskHash }
    }
    for (const n of vanished) if (own(n)) tunnels[n] = own(n)
    this.patch(id, { appliedRev: cfg.rev, endpoints: cfg.endpoints, tunnels })
    await this.sweep(id, vanished)
    this.pending.delete(id)
    this.host.log.info(`Мастер-ключ «${sub.name}»: настройки обновлены${rekeyed ? ', ключ устройства заменён' : ''}`)

    return rekeyed && running ? 'rekeyed' : 'applied'
  }

  /** Servers the key no longer has: their cards go, once they are not the running tunnel. */
  private async sweep(id: string, vanished: number[]): Promise<void> {
    const sub = getSubscription(id) as Subscription
    const tunnels = { ...sub.tunnels }
    for (const n of vanished) {
      const t = tunnels[n]
      if (!t || this.host.tunnels.isActive(t.tunnelId)) continue
      await removeTunnel(t.tunnelId).catch(() => {})
      this.host.tunnels.forget(t.tunnelId)
      delete tunnels[n]
    }
    if (Object.keys(tunnels).length !== Object.keys(sub.tunnels).length) this.patch(id, { tunnels })
  }

  // ── Hooks of the tunnel manager ─────────────────────────────────────────

  /** Before a connect: the newest settings, if the server answers quickly; otherwise the ones already saved. */
  async beforeConnect(tunnelId: string): Promise<void> {
    const subId = listTunnels().find((t) => t.id === tunnelId)?.source?.subId
    const sub = subId ? getSubscription(subId) : undefined
    if (!sub || sub.status === 'revoked') return
    await withTimeout(this.refresh(sub.id, { force: true }), BEFORE_CONNECT_MS)
  }

  /**
   * The handshake of a master key's tunnel is gone (or never came). The usual reason is that the server's
   * settings changed under it, so fetch them. When the tunnel itself is what blocks the request (Windows,
   * Linux), it is taken down for that one exchange.
   */
  async onStale(tunnelId: string): Promise<void> {
    const subId = listTunnels().find((t) => t.id === tunnelId)?.source?.subId
    const sub = subId ? getSubscription(subId) : undefined
    if (!sub || sub.status === 'revoked') return
    const now = this.host.now()
    if (now - (this.lastStaleTry.get(sub.id) ?? 0) < STALE_RETRY_MS) return
    this.lastStaleTry.set(sub.id, now)

    const outcome = await this.refresh(sub.id, { force: true })
    if (outcome === 'failed' && this.host.platform !== 'macos') {
      // On macOS the route to the server stays outside the tunnel, so a failure there is a real one.
      this.host.log.info(`Мастер-ключ «${sub.name}»: туннель мешает запросу настроек — отключаю его на время запроса`)
      await this.host.tunnels.disconnect(tunnelId)
      await this.refresh(sub.id, { force: true })
      await this.host.tunnels.connect(tunnelId).catch(() => {})
    } else if (outcome === 'applied' || outcome === 'rekeyed') {
      await this.host.tunnels.reconnect().catch(() => {})
    }
  }

  // ── Timers ──────────────────────────────────────────────────────────────

  start(): void {
    const all = (): void => {
      for (const s of listSubscriptions()) if (s.status !== 'revoked') void this.refresh(s.id)
    }
    this.timers = [setTimeout(all, FIRST_POLL_MS).unref(), setInterval(all, POLL_MS).unref()]
  }

  dispose(): void {
    for (const t of this.timers) {
      clearTimeout(t)
      clearInterval(t)
    }
    this.timers = []
  }

  // ── Plumbing ────────────────────────────────────────────────────────────

  private locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(id) ?? Promise.resolve()).then(fn, fn)
    this.locks.set(id, run.catch(() => {}))
    return run
  }

  private patch(id: string, patch: Partial<Subscription>): void {
    const sub = getSubscription(id)
    if (sub) saveSubscription({ ...sub, ...patch })
  }

  /** Signs with the auth key: here, or in the Linux service when it is the one holding it. */
  private async sign(id: string, message: string): Promise<Buffer> {
    const secrets = loadSecrets(authKeyId(id))
    if (!secrets) throw new SenError('unauthorized', 'ключ устройства не найден')
    if (secrets.heldByService) {
      if (!this.host.serviceSign) throw new SenError('unauthorized', 'служба SenAWG недоступна')
      return this.host.serviceSign(authKeyId(id), message)
    }
    return crypto.sign(null, Buffer.from(message, 'utf8'), privateKeyFromSeed(Buffer.from(secrets.privateKey, 'base64')))
  }

  private call(sub: Subscription, method: SenRequest['method'], path: string, body?: unknown): Promise<SenResponse> {
    const fromConfig = sub.endpoints.map(parseHostPort).filter((a): a is SenAddr => a !== null)
    const seen = new Set<string>()
    const addrs = [...fromConfig, ...sub.addrs].filter((a) => !seen.has(addrString(a)) && !!seen.add(addrString(a)))
    return this.host.request(
      {
        addrs,
        tls: sub.tls,
        tlsPin: sub.tlsPin ? Buffer.from(sub.tlsPin, 'base64') : undefined,
        signPub: Buffer.from(sub.signPub, 'base64')
      },
      {
        method,
        path,
        body,
        device: sub.device,
        version: this.host.version,
        sign: (m) => this.sign(sub.id, m),
        // Saved before it is sent: a request that died halfway may still have reached the server.
        nextTs: () => {
          const cur = getSubscription(sub.id) as Subscription
          const ts = Math.max(Math.floor(this.host.now() / 1000), cur.lastTs + 1)
          saveSubscription({ ...cur, lastTs: ts })
          return ts
        }
      }
    )
  }
}
