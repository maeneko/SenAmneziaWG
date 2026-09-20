import { execFile } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { createSocket } from 'node:dgram'
import { connect } from 'node:net'
import type { LogLevel, TunnelStats } from '../../shared/types'

/** Well-known anycast address: reaching it proves packets leave through the tunnel and come back. */
const PROBE_IP = '1.1.1.1'
const PROBE_PORT = 443
const PROBE_HOST = 'example.com'

export interface ResolverInfo {
  iface: string
  nameservers: string[]
  reachable: boolean
}

export interface ProbeResult {
  routeIface: string | null
  resolverIface: string | null
  resolver?: ResolverInfo | null
  tcp: 'ok' | 'timeout' | 'error'
  tcpMs?: number
  dns: 'ok' | 'fail'
  /** Seconds until the system resolver first answered (it may recover after mDNSResponder restarts). */
  dnsAfterSec?: number
  /** Direct UDP query to the resolver's first nameserver, bypassing mDNSResponder. */
  udpDns?: 'ok' | 'timeout' | 'error'
  udpDnsServer?: string
  rxDelta: number
  txDelta: number
}

/** `route -n get` output → the interface the kernel would use. */
export function parseRouteInterface(output: string): string | null {
  return /^\s*interface:\s*(\S+)/m.exec(output)?.[1] ?? null
}

/** `scutil --dns` output → the first non-supplemental resolver that has nameservers (the one macOS uses). */
export function parsePrimaryResolver(output: string): ResolverInfo | null {
  // Only the first section: `scutil --dns` repeats the resolvers per interface under "for scoped queries".
  const main = output.split(/DNS configuration \(for scoped queries\)/)[0]
  for (const block of main.split(/\n(?=resolver #)/)) {
    if (!/nameserver\[0]/.test(block) || /flags\s*:.*Supplemental/.test(block)) continue
    return {
      iface: /if_index\s*:\s*\d+\s*\((\S+)\)/.exec(block)?.[1] ?? 'default',
      nameservers: [...block.matchAll(/nameserver\[\d+]\s*:\s*(\S+)/g)].map((m) => m[1]),
      reachable: !/reach\s*:.*Not Reachable/.test(block)
    }
  }
  return null
}

export const parsePrimaryResolverIface = (output: string): string | null => parsePrimaryResolver(output)?.iface ?? null

/** Minimal DNS query for `name` A/IN. */
export function buildDnsQuery(id: number, name: string): Buffer {
  const labels = name.split('.').flatMap((l) => [Buffer.from([l.length]), Buffer.from(l, 'ascii')])
  const header = Buffer.from([id >> 8, id & 0xff, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0])
  return Buffer.concat([header, ...labels, Buffer.from([0, 0, 1, 0, 1])])
}

/** True for a response to `id` with RCODE 0 and at least one answer. */
export function isDnsAnswer(msg: Buffer, id: number): boolean {
  return msg.length >= 12 && msg.readUInt16BE(0) === id && (msg[2] & 0x80) !== 0 && (msg[3] & 0x0f) === 0 && msg.readUInt16BE(6) > 0
}

const run = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve) => execFile(file, args, { timeout: 3000 }, (_e, stdout) => resolve(stdout ?? '')))

/** The two questions the probe asks the operating system; each platform answers them its own way. */
export interface NetProbes {
  /** The interface the system would use to reach `ip`; null when there is no route. */
  routeInterface(ip: string): Promise<string | null>
  /** The resolver the system asks first; null when it has none. */
  primaryResolver(): Promise<ResolverInfo | null>
}

export const macosNetProbes: NetProbes = {
  routeInterface: async (ip) => parseRouteInterface(await run('/sbin/route', ['-n', 'get', ip])),
  primaryResolver: async () => parsePrimaryResolver(await run('/usr/sbin/scutil', ['--dns']))
}

function tcpProbe(): Promise<{ result: 'ok' | 'timeout' | 'error'; ms: number }> {
  const started = Date.now()
  return new Promise((resolve) => {
    const sock = connect({ host: PROBE_IP, port: PROBE_PORT })
    const done = (result: 'ok' | 'timeout' | 'error'): void => {
      sock.destroy()
      resolve({ result, ms: Date.now() - started })
    }
    sock.setTimeout(5000, () => done('timeout'))
    sock.once('connect', () => done('ok'))
    sock.once('error', () => done('error'))
  })
}

/** System resolver (getaddrinfo → mDNSResponder), retried for ~10 s: it restarts when DNS changes. */
async function dnsProbe(): Promise<{ result: 'ok' | 'fail'; afterSec?: number }> {
  const started = Date.now()
  while (Date.now() - started < 10_000) {
    try {
      await Promise.race([lookup(PROBE_HOST), new Promise((_, rej) => setTimeout(() => rej(new Error()), 3000))])
      return { result: 'ok', afterSec: Math.round((Date.now() - started) / 1000) }
    } catch {
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  return { result: 'fail' }
}

function udpDnsProbe(server: string): Promise<'ok' | 'timeout' | 'error'> {
  return new Promise((resolve) => {
    const sock = createSocket(server.includes(':') ? 'udp6' : 'udp4')
    const id = Math.floor(Math.random() * 0xffff)
    const done = (r: 'ok' | 'timeout' | 'error'): void => {
      clearTimeout(timer)
      sock.close()
      resolve(r)
    }
    const timer = setTimeout(() => done('timeout'), 4000)
    sock.on('message', (msg) => isDnsAnswer(msg, id) && done('ok'))
    sock.on('error', () => done('error'))
    sock.send(buildDnsQuery(id, PROBE_HOST), 53, server, (err) => err && done('error'))
  })
}

/** Unprivileged end-to-end check of a freshly handshaken tunnel. */
export async function probeTunnel(stats: () => Promise<TunnelStats>, net: NetProbes = macosNetProbes): Promise<ProbeResult> {
  const before = await stats()
  const [routeIface, resolver] = await Promise.all([net.routeInterface(PROBE_IP), net.primaryResolver()])
  const udpDnsServer = resolver?.nameservers[0] ?? PROBE_IP
  const [tcp, udpDns] = await Promise.all([tcpProbe(), udpDnsProbe(udpDnsServer)])
  const dns = await dnsProbe()
  const after = await stats()
  return {
    routeIface,
    resolverIface: resolver?.iface ?? null,
    resolver,
    tcp: tcp.result,
    tcpMs: tcp.ms,
    dns: dns.result,
    dnsAfterSec: dns.afterSec,
    udpDns,
    udpDnsServer,
    rxDelta: after.rxBytes - before.rxBytes,
    txDelta: after.txBytes - before.txBytes
  }
}

/** How the journal names the operating system and «this computer». */
export interface OsLabel {
  name: string
  machine: string
}
export const MACOS: OsLabel = { name: 'macOS', machine: 'этом Mac' }
export const WINDOWS: OsLabel = { name: 'Windows', machine: 'этом компьютере' }

/** Turns a probe into journal lines, naming the most likely cause when something is off. */
export function describeProbe(p: ProbeResult, iface: string, os: OsLabel = process.platform === 'win32' ? WINDOWS : MACOS): { level: LogLevel; message: string }[] {
  const out: { level: LogLevel; message: string }[] = []
  const bytes = `отправлено ${p.txDelta} Б, получено ${p.rxDelta} Б`

  if (p.routeIface !== iface) {
    out.push({
      level: 'error',
      message: `Проверка: трафик в интернет идёт через ${p.routeIface ?? '(нет маршрута)'}, а не через туннель ${iface}`
    })
  }
  if (p.resolverIface && p.resolverIface !== 'default' && p.resolverIface !== iface) {
    out.push({
      level: 'warn',
      message: `Проверка: основной DNS-резолвер ${os.name} привязан к ${p.resolverIface} — возможно, активен другой VPN`
    })
  }

  if (p.tcp === 'ok') {
    const via = p.routeIface === iface ? 'через туннель' : `через ${p.routeIface ?? '?'}, в обход туннеля`
    out.push({ level: 'info', message: `Проверка связи: ${PROBE_IP}:${PROBE_PORT} доступен ${via} за ${p.tcpMs} мс` })
  } else if (p.txDelta > 0 && p.rxDelta === 0) {
    out.push({
      level: 'error',
      message:
        `Проверка связи: пакеты уходят на сервер, но ответа нет (${bytes}). Рукопожатие проходит, а трафик сервер ` +
        'не возвращает: этот ключ может быть одновременно подключён на другом устройстве, либо сервер не выпускает ' +
        'трафик клиента в интернет'
    })
  } else if (p.txDelta === 0) {
    out.push({ level: 'error', message: `Проверка связи: пакеты не уходят в туннель (${bytes}) — проблема с маршрутами на ${os.machine}` })
  } else {
    out.push({ level: 'error', message: `Проверка связи: ${PROBE_IP}:${PROBE_PORT} недоступен (${p.tcp}, ${bytes})` })
  }

  if (p.resolver) {
    const r = p.resolver
    out.push({
      level: 'info',
      message: `Проверка DNS: ${os.name} использует ${r.nameservers.join(', ')} (интерфейс ${r.iface}${r.reachable ? '' : `, ${os.name} помечает его недоступным`})`
    })
  } else if (p.resolver === null) {
    out.push({ level: 'error', message: `Проверка DNS: у ${os.name} нет ни одного DNS-сервера` })
  }
  if (p.udpDns) {
    out.push(
      p.udpDns === 'ok'
        ? { level: 'info', message: `Проверка DNS: прямой запрос к ${p.udpDnsServer} по UDP получил ответ` }
        : { level: 'error', message: `Проверка DNS: прямой запрос к ${p.udpDnsServer} по UDP — ${p.udpDns === 'timeout' ? 'нет ответа' : 'ошибка отправки'}` }
    )
  }

  if (p.dns === 'ok') {
    out.push({
      level: p.dnsAfterSec ? 'warn' : 'info',
      message: p.dnsAfterSec ? `Проверка DNS: имена разрешаются, но только через ${p.dnsAfterSec} с после подключения` : 'Проверка DNS: имена разрешаются'
    })
  } else if (p.udpDns === 'ok') {
    out.push({
      level: 'error',
      message:
        `Проверка DNS: DNS-сервер отвечает через туннель, но системный резолвер ${os.name} имена не разрешает — ` +
        `проблема в настройке DNS на ${os.machine}, а не в сервере`
    })
  } else if (p.tcp === 'ok' && p.udpDns) {
    out.push({
      level: 'error',
      message: 'Проверка DNS: TCP через туннель работает, а DNS по UDP — нет. Сервер или провайдер режет UDP/53 внутри туннеля'
    })
  } else {
    out.push({ level: 'error', message: 'Проверка DNS: имена не разрешаются — сайты открываться не будут' })
  }
  return out
}
