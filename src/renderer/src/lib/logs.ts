import type { LogEntry, LogSource } from '@shared/types'

/** Same cap as the main-process buffer. */
export const MAX_LOGS = 1000

export type LogFilter = 'all' | LogSource

/** Union by id, oldest first, capped. Safe when a pushed batch races the initial fetch. */
export function mergeLogs(prev: LogEntry[], incoming: LogEntry[]): LogEntry[] {
  if (!incoming.length) return prev
  const seen = new Set(prev.map((e) => e.id))
  const fresh = incoming.filter((e) => !seen.has(e.id))
  if (!fresh.length) return prev
  const all = [...prev, ...fresh].sort((a, b) => a.id - b.id)
  return all.length > MAX_LOGS ? all.slice(all.length - MAX_LOGS) : all
}

export const filterLogs = (entries: LogEntry[], filter: LogFilter): LogEntry[] =>
  filter === 'all' ? entries : entries.filter((e) => e.source === filter)

const pad = (n: number): string => String(n).padStart(2, '0')

export function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export interface LogRun {
  /** First entry of the run: its id is the stable React key. */
  entry: LogEntry
  count: number
}

/** Consecutive entries with the same source, level and message become one run with a counter. */
export function collapseRepeats(entries: LogEntry[]): LogRun[] {
  const runs: LogRun[] = []
  for (const entry of entries) {
    const last = runs[runs.length - 1]
    if (last && last.entry.source === entry.source && last.entry.level === entry.level && last.entry.message === entry.message) {
      last.count++
    } else {
      runs.push({ entry, count: 1 })
    }
  }
  return runs
}
