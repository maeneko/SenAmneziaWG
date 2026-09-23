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

/** How long an identical warning or error is counted instead of written again. */
export const REPEAT_WINDOW_MS = 30_000

/**
 * Collapses a daemon's repeated warnings and errors. When the network breaks under it, amneziawg-go
 * writes the same «Failed to send» line for every packet — thousands a minute, enough to push
 * everything else out of the journal. The first one is written as is; the repeats are counted and
 * written as one line per window while they go on. Debug and info lines always pass: their
 * sequence is what a reader follows.
 */
export class RepeatFilter {
  private seen = new Map<string, { level: LogLevel; source: LogSource; message: string; until: number; count: number }>()

  constructor(private readonly windowMs = REPEAT_WINDOW_MS) {}

  filter(drafts: Draft[], now = Date.now()): Draft[] {
    const out = this.flush(now)
    for (const d of drafts) {
      if (d.level !== 'warn' && d.level !== 'error') {
        out.push(d)
        continue
      }
      const key = `${d.source}\u0000${d.level}\u0000${d.message}`
      const entry = this.seen.get(key)
      if (entry) {
        entry.count++
      } else {
        this.seen.set(key, { ...d, until: now + this.windowMs, count: 0 })
        out.push(d)
      }
    }
    return out
  }

  /** Summaries of windows that have ended. A window with repeats starts the next one; a quiet one ends. */
  private flush(now: number): Draft[] {
    const out: Draft[] = []
    for (const [key, e] of this.seen) {
      if (now < e.until) continue
      if (e.count === 0) {
        this.seen.delete(key)
        continue
      }
      const seconds = Math.round((now - e.until + this.windowMs) / 1000)
      out.push({ level: e.level, source: e.source, message: `${e.message} — повторов за ${seconds} с: ${e.count}` })
      e.count = 0
      e.until = now + this.windowMs
    }
    return out
  }
}
