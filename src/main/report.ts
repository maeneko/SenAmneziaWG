import { REPORT_LOGS_MAX, REPORT_LOGS_WINDOW_MS, type LogEntry } from '../shared/types'
import { formatEntries } from './logger'
import type { Ma7Report } from './ma7'
import { splitEndpoint } from './tunnel/uapiConfig'

/** What a «Репорт» is put together from: the person's choices and what this computer knows. */
export interface ReportSource {
  message: string
  /** The server the person picked; absent — not about a server. */
  tunnel?: { name: string; endpoint: string }
  /** The whole journal: only its last REPORT_LOGS_WINDOW_MS go, and only with `withLogs`. */
  entries: LogEntry[]
  now: number
  appVersion: string
  /** What the device is; sent only with `withDevice`. */
  systemInfo: string
  withLogs: boolean
  withDevice: boolean
}

/** The server's address in a «Репорт»: the host alone, the port says nothing to whoever reads it. */
export function reportHost(endpoint: string): string {
  try {
    return splitEndpoint(endpoint).host
  } catch {
    return endpoint
  }
}

/**
 * The «Репорт» exactly as it will go to MA7 — what the review step shows and what «Отправить» sends: the server
 * by its name and address, the journal of the last half hour as «Копировать» gives it (its tail, if longer),
 * the device only when asked. `logEntries`: how many journal lines went in, for the review step to say.
 */
export function buildReport(s: ReportSource): { report: Ma7Report; logEntries: number } {
  const since = s.now - REPORT_LOGS_WINDOW_MS
  const recent = s.withLogs ? s.entries.filter((e) => e.ts >= since) : []
  const journal = formatEntries(recent)
  return {
    report: {
      message: s.message,
      server: s.tunnel ? `${s.tunnel.name} (${reportHost(s.tunnel.endpoint)})` : null,
      logs: journal ? journal.slice(-REPORT_LOGS_MAX) : null,
      appVersion: s.appVersion,
      systemInfo: s.withDevice ? s.systemInfo : null
    },
    logEntries: recent.length
  }
}
