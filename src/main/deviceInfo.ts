import { app, screen } from 'electron'
import { statfs } from 'node:fs/promises'
import { arch, cpus, freemem, release, totalmem, uptime } from 'node:os'
import { REPORT_LOGS_WINDOW_MS } from '../shared/types'
import { cpuBusyShare, formatDevice, linuxDistro, type CpuTimes, type DeviceFacts } from './systemInfo'

/** How often the processor's counters are read for the «Репорт»'s average load. */
const CPU_SAMPLE_MS = 60_000
/** Readings kept: the journal's half hour of a «Репорт», and one more for its start. */
const CPU_SAMPLES = REPORT_LOGS_WINDOW_MS / CPU_SAMPLE_MS + 1

const readCpu = (): { at: number; times: CpuTimes[] } => ({ at: Date.now(), times: cpus().map((c) => c.times) })
const cpuSamples: { at: number; times: CpuTimes[] }[] = []

/**
 * Starts reading the processor's counters once a minute, so a «Репорт» can say how loaded it was on average over
 * the half hour its journal covers — os.loadavg() says nothing on Windows (always zeros), and a single reading at
 * the moment of «Далее» says only how busy the report itself made it. A few numbers a minute; the timer does not
 * keep the application alive.
 */
export function startCpuSampler(): void {
  if (cpuSamples.length > 0) return
  cpuSamples.push(readCpu())
  setInterval(() => {
    cpuSamples.push(readCpu())
    if (cpuSamples.length > CPU_SAMPLES) cpuSamples.splice(0, cpuSamples.length - CPU_SAMPLES)
  }, CPU_SAMPLE_MS).unref()
}

/** The average since the oldest reading kept, and over the last minute; with no history yet, a short reading now. */
async function cpuLoad(): Promise<DeviceFacts['cpuLoad']> {
  const now = readCpu()
  let oldest = cpuSamples[0]
  if (!oldest || now.at - oldest.at < 1_000) {
    oldest = now
    await new Promise((resolve) => setTimeout(resolve, 500))
    const later = readCpu()
    const share = cpuBusyShare(oldest.times, later.times)
    return share === null ? undefined : { average: share, minutes: 0, recent: null }
  }
  const average = cpuBusyShare(oldest.times, now.times)
  if (average === null) return undefined
  const lastMinute = cpuSamples[cpuSamples.length - 1]
  const recent = now.at - lastMinute.at >= 1_000 ? cpuBusyShare(lastMinute.times, now.times) : null
  return { average, minutes: Math.round((now.at - oldest.at) / 60_000), recent }
}

/** Free and total space of the disk SenAWG keeps its data on; undefined when the system will not say. */
async function diskSpace(): Promise<DeviceFacts['disk']> {
  try {
    const s = await statfs(app.getPath('userData'))
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize }
  } catch {
    return undefined
  }
}

/**
 * The device for a «Репорт» (systemInfo.ts: formatDevice), read now: memory, disk and uptime change, and so do
 * the screens; the processor's load comes from startCpuSampler's readings. `engine` names the engine and how it runs; asked of the backend, which may take a moment or fail.
 */
export async function describeDevice(engine: () => Promise<string>): Promise<string> {
  const cores = cpus()
  const session = [process.env.XDG_SESSION_TYPE, process.env.XDG_CURRENT_DESKTOP].filter(Boolean).join(', ')
  let engineText: string
  try {
    engineText = await engine()
  } catch (err) {
    engineText = err instanceof Error ? err.message : String(err)
  }
  const [load, disk] = await Promise.all([cpuLoad(), diskSpace()])
  return formatDevice({
    platform: process.platform,
    systemVersion: process.getSystemVersion(),
    ...(process.platform === 'linux' ? { distro: linuxDistro() } : {}),
    kernel: release(),
    arch: arch(),
    translated: app.runningUnderARM64Translation,
    cpuModel: cores[0]?.model.trim() || null,
    cpuCount: cores.length,
    memTotal: totalmem(),
    memFree: freemem(),
    ...(disk ? { disk } : {}),
    ...(load ? { cpuLoad: load } : {}),
    uptimeSec: uptime(),
    ...(session ? { session } : {}),
    locale: app.getLocale(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    displays: screen.getAllDisplays().map((d) => ({ width: d.size.width, height: d.size.height, scale: d.scaleFactor })),
    engine: engineText,
    runtime: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    }
  })
}
