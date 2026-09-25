import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { basename, join } from 'node:path'
import type { LogLevel, Tunnel, TunnelStats } from '../../shared/types'
import type { TunnelSecrets } from '../config/wgConfig'
import { AWG_VERSION_LABEL, detectAwgVersion } from '../../shared/awgVersion'
import { binarySupports, parseBinaryVersion, readBinaryVersion } from './binaryVersion'
import { runElevated } from './elevate'
import { splitHelperOutput } from './helperOutput'
import { type ActiveTunnel, type TunnelController, UserCancelledError } from './TunnelController'
import { readStats, socketPath, uapiRequest } from './uapi'
import { buildUapiSet, splitEndpoint } from './uapiConfig'
import { DEFAULT_MTU } from '../config/wgConf'

/** Root-owned state written by awg.sh; readable by everyone, so the app can reattach after a restart. */
export const STATE_FILE = '/var/db/senawg/state.env'
/** amneziawg-go's output; awg.sh creates it world-readable so the Logs tab needs no root. */
export const DAEMON_LOG = '/var/db/senawg/daemon.log'

const CAPTURE_DIR = '/var/db/senawg'

const tcpdumpRead = (file: string, extra: string[] = []): Promise<string> =>
  new Promise((resolve) =>
    execFile('/usr/sbin/tcpdump', ['-r', file, '-nn', ...extra], { maxBuffer: 16 * 1024 * 1024, timeout: 15_000 }, (_e, out, err) =>
      resolve(`${out ?? ''}${err ? `\n${err}` : ''}`)
    )
  )

export type HelperLog = (level: LogLevel, message: string) => void

/**
 * Whether awg.sh's monitor is running: an awg.sh process under that pid (a pid alone may belong to
 * anything by now). It is what re-pins the route to the server after a network change and takes the
 * tunnel down with the application; `ps` needs no root to tell.
 */
export function isMonitorRunning(pid: string | undefined): Promise<boolean> {
  if (!pid || !/^\d+$/.test(pid)) return Promise.resolve(false)
  return new Promise((resolve) =>
    execFile('/bin/ps', ['-p', pid, '-o', 'command='], { timeout: 5_000 }, (err, out) =>
      resolve(!err && String(out).includes('awg.sh'))
    )
  )
}

/** Only used in development when the bundled binary has not been built yet. */
const SYSTEM_BINARIES = ['/usr/local/bin/amneziawg-go', '/opt/homebrew/bin/amneziawg-go']

/**
 * The daemon shipped in the app bundle wins: its version is pinned and matches what the app was tested
 * with. A system-wide install is a development fallback only — packaged builds never use it.
 */
export function findBinary(bundled: string, packaged: boolean): string {
  if (existsSync(bundled)) return bundled
  if (!packaged) {
    const system = SYSTEM_BINARIES.find((p) => existsSync(p))
    if (system) return system
  }
  throw new Error(
    packaged
      ? 'В приложении нет amneziawg-go — сборка повреждена, переустановите SenAWG'
      : 'Нет amneziawg-go: выполните npm run build:awg'
  )
}

export function readStateFile(path = STATE_FILE): Partial<Record<'ID' | 'IFACE' | 'PID' | 'MONITOR_PID', string>> | null {
  try {
    const out: Record<string, string> = {}
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = /^(ID|IFACE|PID|MONITOR_PID)=(\S+)$/.exec(line)
      if (m) out[m[1]] = m[2]
    }
    return out.IFACE ? out : null
  } catch {
    return null
  }
}

/** Diagnostic packet capture awg.sh took right after connecting (--diagnostics); files world-readable. */
export async function readCaptureFiles(): Promise<{ inner: string; outer: string; innerVerbose: string } | null> {
  const inner = join(CAPTURE_DIR, 'capture-inner.pcap')
  const outer = join(CAPTURE_DIR, 'capture-outer.pcap')
  if (!existsSync(inner) && !existsSync(outer)) {
    // tcpdump never started: its error went to the .txt next to it.
    const err = (f: string): string => (existsSync(join(CAPTURE_DIR, f)) ? readFileSync(join(CAPTURE_DIR, f), 'utf8') : '')
    return { inner: err('capture-inner.txt'), outer: err('capture-outer.txt'), innerVerbose: '' }
  }
  const [innerText, outerText, innerVerbose] = await Promise.all([
    tcpdumpRead(inner),
    tcpdumpRead(outer),
    tcpdumpRead(inner, ['-vv'])
  ])
  return { inner: innerText, outer: outerText, innerVerbose }
}

/**
 * The tunnel awg.sh left running, from its world-readable state file and the daemon's UAPI socket (which
 * awg.sh hands to the user who asked for the tunnel): no root, no prompt, no service needed to tell.
 */
export async function recoverFromState(): Promise<ActiveTunnel | null> {
  const state = readStateFile()
  if (!state?.IFACE || !state.ID || !existsSync(socketPath(state.IFACE))) return null
  try {
    await uapiRequest(state.IFACE, 'get=1\n\n', 1500)
    // awg.sh writes the state file last thing in `up` and never again: its mtime is the start time.
    return { id: state.ID, iface: state.IFACE, startedAt: statSync(STATE_FILE).mtimeMs }
  } catch {
    return null
  }
}

/** A dead session's leftovers (DNS, routes) may still be applied: awg.sh's state file with no tunnel behind it. */
export async function hasStaleStateFile(): Promise<boolean> {
  return existsSync(STATE_FILE) && (await recoverFromState()) === null
}

/** Fails fast, before any prompt, when the bundled daemon is older than the config needs. */
export async function checkBinaryFor(binary: string, tunnel: Tunnel, log: HelperLog): Promise<void> {
  const version = parseBinaryVersion(await readBinaryVersion(binary))
  if (!version) {
    log('warn', `Не удалось определить версию ${binary}`)
    return
  }
  log('info', `amneziawg-go ${version.raw} (${binary})`)
  const needed = detectAwgVersion(tunnel.awg)
  if (!binarySupports(version, needed)) {
    throw new Error(
      `Конфиг ${AWG_VERSION_LABEL[needed]}, а установленный amneziawg-go ${version.raw} его не поддерживает. ` +
        `Установите amneziawg-go ${needed === '3.1' ? 'v3.1' : 'v3.0'} или новее`
    )
  }
}

/**
 * The first macOS controller: every privileged step is awg.sh behind an admin prompt. Packaged builds
 * now use MacosServiceController (no prompt per connection); this one stays for development without the
 * service (macosBackend.ts).
 */
export class MacosScriptController implements TunnelController {
  constructor(
    private readonly scriptsDir: string,
    private readonly runDir: string,
    private readonly bundledBinary: string,
    private readonly packaged: boolean,
    private readonly log: HelperLog = () => {},
    private readonly diagnostics: () => boolean = () => false,
    /** DNS servers to set for this tunnel (Настройки → DNS); the key's own list by default. */
    private readonly dnsFor: (tunnel: Tunnel) => string[] = (tunnel) => tunnel.dns
  ) {}

  /** Runs awg.sh as root; warnings go to the journal, a failure becomes a clean Error. */
  private async helper(args: string[], prompt: string): Promise<void> {
    let output: string
    try {
      output = await runElevated(['/bin/bash', this.script, ...args], prompt)
    } catch (err) {
      if (err instanceof UserCancelledError) throw err
      const { warnings, rest } = splitHelperOutput(err instanceof Error ? err.message : String(err))
      for (const w of warnings) this.log('warn', w)
      throw new Error(rest || 'Не удалось выполнить действие с правами администратора')
    }
    for (const w of splitHelperOutput(output).warnings) this.log('warn', w)
  }

  private get script(): string {
    return join(this.scriptsDir, 'awg.sh')
  }

  async up(tunnel: Tunnel, secrets: TunnelSecrets, replace = false): Promise<ActiveTunnel> {
    const binary = this.binary()
    await this.checkBinary(binary, tunnel)
    const { host } = splitEndpoint(tunnel.endpoint)
    const endpointIp = isIP(host) ? host : (await lookup(host)).address

    // The key travels in a 0600 file (argv is visible in `ps`); the script deletes it after use.
    mkdirSync(this.runDir, { recursive: true, mode: 0o700 })
    const bodyFile = join(this.runDir, `${tunnel.id}.uapi`)
    writeFileSync(bodyFile, buildUapiSet(tunnel, secrets, endpointIp), { mode: 0o600 })

    const args = [
      'up',
      '--id', tunnel.id,
      '--uid', String(process.getuid?.() ?? 0),
      '--bin', binary,
      '--body', bodyFile,
      '--endpoint-ip', endpointIp,
      '--address', tunnel.address.replace(/\s+/g, ''),
      '--allowed', tunnel.allowedIps.join(','),
      '--mtu', String(tunnel.mtu ?? DEFAULT_MTU),
      // The tunnel must not outlive this process: the script's root monitor watches it and tears the
      // tunnel down the moment it is gone, however it goes — quit, crash or Force Quit. Nobody else
      // could: stopping a root daemon needs root, and asking for it is exactly what a dead
      // application cannot do.
      '--app-pid', String(process.pid),
      '--app-cmd', basename(process.execPath)
    ]
    const dns = this.dnsFor(tunnel)
    if (dns.length) args.push('--dns', dns.join(','))
    this.log('info', dns.length ? `DNS: ${dns.join(', ')}` : 'DNS не задан — остаётся DNS системы')
    if (this.diagnostics()) args.push('--diagnostics', '1')
    if (replace) args.push('--replace', '1')

    try {
      await this.helper(args, replace ? 'SenAWG переключает VPN-туннель на другой сервер.' : 'SenAWG создаёт VPN-туннель.')
    } finally {
      rmSync(bodyFile, { force: true })
    }

    const state = readStateFile()
    if (!state?.IFACE) throw new Error('Туннель запущен, но интерфейс не определён')
    return { id: tunnel.id, iface: state.IFACE, endpointIp, localIp: tunnel.address.split(',')[0].split('/')[0].trim() }
  }

  readCapture(): Promise<{ inner: string; outer: string; innerVerbose: string } | null> {
    return readCaptureFiles()
  }

  binary(): string {
    return findBinary(this.bundledBinary, this.packaged)
  }

  private checkBinary(binary: string, tunnel: Tunnel): Promise<void> {
    return checkBinaryFor(binary, tunnel, this.log)
  }

  async down(_active: ActiveTunnel): Promise<void> {
    await this.helper(['down'], 'SenAWG останавливает VPN-туннель.')
  }

  hasStaleState(): Promise<boolean> {
    return hasStaleStateFile()
  }

  async cleanup(): Promise<void> {
    // awg.sh down tears down whatever the state file records, running daemon or not.
    await this.helper(['down'], 'SenAWG восстанавливает сетевые настройки после прошлого подключения.')
  }

  stats(active: ActiveTunnel): Promise<TunnelStats> {
    return readStats(active.iface)
  }

  async watchdogAlive(): Promise<boolean> {
    return isMonitorRunning(readStateFile()?.MONITOR_PID)
  }

  recover(): Promise<ActiveTunnel | null> {
    return recoverFromState()
  }
}
