import { readFileSync } from 'node:fs'
import { arch, release } from 'node:os'

/** PRETTY_NAME from os-release, e.g. «Ubuntu 24.04.1 LTS». */
export function parseOsRelease(text: string): string | null {
  const m = /^PRETTY_NAME=(?:"([^"]*)"|'([^']*)'|(.*))$/m.exec(text)
  return (m?.[1] ?? m?.[2] ?? m?.[3])?.trim() || null
}

export function linuxDistro(): string {
  for (const path of ['/etc/os-release', '/usr/lib/os-release']) {
    try {
      const name = parseOsRelease(readFileSync(path, 'utf8'))
      if (name) return name
    } catch {
      // next
    }
  }
  return 'Linux'
}

/** One journal line about the machine: what a bug report needs first and a user rarely says. */
export function describeSystem(platform = process.platform, env = process.env): string {
  if (platform !== 'linux') return `Система: ${platform} ${release()}, ${arch()}`
  const session = [env.XDG_SESSION_TYPE, env.XDG_CURRENT_DESKTOP].filter(Boolean).join(', ')
  return `Система: ${linuxDistro()}, ядро ${release()}, ${arch()}${session ? `, сеанс ${session}` : ''}`
}

/**
 * What a «Репорт» says about the device (Настройки → Диагностика → «Репорт», «Приложить данные об устройстве»).
 * Only what helps to find a fault: the system and its build, the hardware, the screen, the engine and the runtime.
 * Nothing that names the person or the machine — no computer or user name, no addresses of any kind.
 */
export interface DeviceFacts {
  platform: NodeJS.Platform
  /** process.getSystemVersion(): «15.6.1» on macOS, «10.0.22631» on Windows. */
  systemVersion: string
  /** Linux: PRETTY_NAME from os-release. */
  distro?: string
  kernel: string
  arch: string
  /** An x64 build running on an ARM machine (Rosetta, Windows on ARM). */
  translated: boolean
  cpuModel: string | null
  cpuCount: number
  memTotal: number
  memFree: number
  /** The disk SenAWG keeps its data on; absent when it could not be read. */
  disk?: { total: number; free: number }
  /** CPU busy share (0..1): on average over `minutes`, and over the last minute; absent before anything was measured. */
  cpuLoad?: { average: number; minutes: number; recent: number | null }
  uptimeSec: number
  /** Linux: «wayland, GNOME». */
  session?: string
  locale: string
  timeZone: string
  displays: { width: number; height: number; scale: number }[]
  /** «amneziawg-go v3.1.… — bundled», or why it could not be told. */
  engine: string
  runtime: { electron: string; chrome: string; node: string }
}

/** The system as people call it: «macOS 15.6.1», «Windows 11 (сборка 22631)», «Ubuntu 24.04.1 LTS». */
export function osName(platform: NodeJS.Platform, systemVersion: string, distro?: string): string {
  if (platform === 'darwin') return `macOS ${systemVersion}`
  if (platform === 'win32') {
    const [major, , build] = systemVersion.split('.').map(Number)
    // Windows 11 still says 10.0: the build tells them apart, 22000 and up is 11.
    if (major === 10 && Number.isFinite(build)) return `Windows ${build >= 22000 ? 11 : 10} (сборка ${build})`
    return `Windows ${systemVersion}`
  }
  if (platform === 'linux') return distro || 'Linux'
  return `${platform} ${systemVersion}`
}

/** «1 ядро», «4 ядра», «12 ядер». */
function cores(n: number): string {
  const ten = n % 10
  const hundred = n % 100
  if (ten === 1 && hundred !== 11) return 'ядро'
  if (ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14)) return 'ядра'
  return 'ядер'
}

/** os.cpus()[i].times: milliseconds each core spent in each mode since boot. */
export type CpuTimes = { user: number; nice: number; sys: number; idle: number; irq: number }

/**
 * How busy the processor was between two readings of os.cpus(): the share of all cores' time not spent idle.
 * Null when nothing passed between them (or the cores do not match — a core taken offline).
 */
export function cpuBusyShare(before: CpuTimes[], after: CpuTimes[]): number | null {
  if (before.length === 0 || before.length !== after.length) return null
  let busy = 0
  let total = 0
  after.forEach((t, i) => {
    const b = before[i]
    const idle = t.idle - b.idle
    const all = t.user - b.user + (t.nice - b.nice) + (t.sys - b.sys) + (t.irq - b.irq) + idle
    total += all
    busy += all - idle
  })
  return total > 0 ? Math.min(1, Math.max(0, busy / total)) : null
}

const percent = (share: number): string => `${Math.round(share * 100)}%`

const gb = (bytes: number): string => `${(bytes / 2 ** 30).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ГБ`

function duration(sec: number): string {
  const days = Math.floor(sec / 86_400)
  const hours = Math.floor((sec % 86_400) / 3_600)
  const minutes = Math.floor((sec % 3_600) / 60)
  if (days > 0) return `${days} д ${hours} ч`
  if (hours > 0) return `${hours} ч ${minutes} мин`
  return `${minutes} мин`
}

/** «в среднем 23% за 30 мин, за последнюю минуту 41%»; under a minute of history, the one reading there is. */
function cpuLoadText(load: NonNullable<DeviceFacts['cpuLoad']>): string {
  if (load.minutes < 1) return `${percent(load.average)} сейчас`
  const average = `в среднем ${percent(load.average)} за ${load.minutes} мин`
  return load.recent === null || load.minutes <= 1 ? average : `${average}, за последнюю минуту ${percent(load.recent)}`
}

/** The device as «Метка: значение» lines — the system first, the line the admin's Telegram message shows. */
export function formatDevice(f: DeviceFacts): string {
  const lines = [
    `Система: ${osName(f.platform, f.systemVersion, f.distro)}`,
    `Ядро: ${f.kernel}`,
    `Архитектура: ${f.arch}${f.translated ? ' (x64 в эмуляции)' : ''}`,
    `Процессор: ${f.cpuModel ? `${f.cpuModel}, ` : ''}${f.cpuCount} ${cores(f.cpuCount)}`,
    `Память: ${gb(f.memTotal)}, свободно ${gb(f.memFree)}`
  ]
  if (f.cpuLoad) lines.push(`Загрузка процессора: ${cpuLoadText(f.cpuLoad)}`)
  if (f.disk) lines.push(`Диск: свободно ${gb(f.disk.free)} из ${gb(f.disk.total)}`)
  lines.push(`Система работает: ${duration(f.uptimeSec)}`)
  if (f.session) lines.push(`Сеанс: ${f.session}`)
  lines.push(`Язык и часовой пояс: ${f.locale}, ${f.timeZone}`)
  if (f.displays.length > 0) {
    lines.push(`Экран: ${f.displays.map((d) => `${d.width}×${d.height}${d.scale !== 1 ? ` ×${d.scale}` : ''}`).join('; ')}`)
  }
  lines.push(`Движок: ${f.engine}`)
  lines.push(`Electron ${f.runtime.electron} · Chromium ${f.runtime.chrome} · Node ${f.runtime.node}`)
  return lines.join('\n')
}
