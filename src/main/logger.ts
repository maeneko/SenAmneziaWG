import type { LogEntry, LogLevel, LogSource } from '../shared/types'

export const MAX_LOG_ENTRIES = 1000

// WireGuard keys are 32 bytes: 44-char base64 (ends in "=") or 64-char hex in UAPI. They must never reach the journal.
const KEY_PATTERNS = [/[A-Za-z0-9+/]{43}=/g, /\b[0-9a-fA-F]{64}\b/g]

export function redact(message: string): string {
  return KEY_PATTERNS.reduce((text, re) => text.replace(re, '[ключ скрыт]'), message)
}

type Draft = Pick<LogEntry, 'level' | 'source' | 'message'>

/** In-memory ring buffer with push subscribers. No Electron imports, so it is unit-testable. */
export class Logger {
  private entries: LogEntry[] = []
  private nextId = 1
  private listeners = new Set<(entries: LogEntry[]) => void>()

  add(level: LogLevel, source: LogSource, message: string): void {
    this.addMany([{ level, source, message }])
  }

  info = (message: string): void => this.add('info', 'app', message)
  warn = (message: string): void => this.add('warn', 'app', message)
  error = (message: string): void => this.add('error', 'app', message)

  addMany(drafts: Draft[]): void {
    if (!drafts.length) return
    const ts = Date.now()
    const created = drafts.map((d) => ({ id: this.nextId++, ts, ...d, message: redact(d.message) }))
    this.entries.push(...created)
    if (this.entries.length > MAX_LOG_ENTRIES) this.entries.splice(0, this.entries.length - MAX_LOG_ENTRIES)
    for (const cb of this.listeners) cb(created)
  }

  list(source: LogSource | 'all' = 'all'): LogEntry[] {
    return source === 'all' ? [...this.entries] : this.entries.filter((e) => e.source === source)
  }

  clear(): void {
    this.entries = []
  }

  subscribe(cb: (entries: LogEntry[]) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
}

const pad = (n: number): string => String(n).padStart(2, '0')

export function formatEntry(e: LogEntry): string {
  const d = new Date(e.ts)
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  return `${stamp} [${e.source}] ${e.level.toUpperCase().padEnd(5)} ${e.message}`
}

export const formatEntries = (entries: LogEntry[]): string => entries.map(formatEntry).join('\n')

const DAEMON_LINE = /^(ERROR|WARNING|INFO|DEBUG|VERBOSE):\s*(.*)$/
// wireguard-go prefixes each line with "(utun4) 2026/09/19 12:00:00 " — we stamp our own time.
const DAEMON_PREFIX = /^\(\S+\)\s\d{4}\/\d\d\/\d\d\s\d\d:\d\d:\d\d\s/
const LEVELS: Record<string, LogLevel> = { ERROR: 'error', WARNING: 'warn', INFO: 'info', DEBUG: 'debug', VERBOSE: 'debug' }

export function parseDaemonLine(line: string): Draft {
  const m = DAEMON_LINE.exec(line)
  if (!m) return { level: 'info', source: 'tunnel', message: line }
  return { level: LEVELS[m[1]], source: 'tunnel', message: m[2].replace(DAEMON_PREFIX, '') }
}
