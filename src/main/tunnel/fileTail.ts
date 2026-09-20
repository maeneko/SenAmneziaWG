import { closeSync, openSync, readSync, statSync } from 'node:fs'

const MAX_READ = 256 * 1024
const RECENT_BYTES = 8 * 1024

/**
 * A different file, as far as the inode can tell. Windows may report 0 (or an id it cannot represent), and
 * then only the size check below can notice a replacement.
 */
const replaced = (before: number | null, now: number): boolean => before !== null && before > 0 && now > 0 && before !== now

/**
 * Follows a log file that another process (a root daemon) writes. Survives the file being replaced
 * (new inode) or truncated, and never emits half-written lines or split multi-byte characters.
 */
export class FileTail {
  private timer: NodeJS.Timeout | null = null
  private ino: number | null = null
  private offset = 0
  private pending: Buffer = Buffer.alloc(0)

  constructor(
    private readonly path: string,
    private readonly onLines: (lines: string[]) => void,
    private readonly intervalMs = 1000
  ) {}

  /** 'end' ignores what is already in the file; 'recent' starts a few KB before the end. */
  start(from: 'end' | 'recent'): void {
    this.stop()
    this.pending = Buffer.alloc(0)
    try {
      const st = statSync(this.path)
      this.ino = st.ino
      this.offset = from === 'end' ? st.size : Math.max(0, st.size - RECENT_BYTES)
      if (from === 'recent' && this.offset > 0) this.skipPartialFirstLine()
    } catch {
      this.ino = null
      this.offset = 0
    }
    this.timer = setInterval(() => this.poll(), this.intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  poll(): void {
    let st
    try {
      st = statSync(this.path)
    } catch {
      this.ino = null
      this.offset = 0
      this.pending = Buffer.alloc(0)
      return
    }
    if (replaced(this.ino, st.ino) || st.size < this.offset) {
      // A new file (or one truncated in place): read it from the top.
      this.offset = 0
      this.pending = Buffer.alloc(0)
    }
    this.ino = st.ino
    if (st.size <= this.offset) return

    const length = Math.min(st.size - this.offset, MAX_READ)
    const buf = Buffer.alloc(length)
    let read = 0
    try {
      const fd = openSync(this.path, 'r')
      try {
        read = readSync(fd, buf, 0, length, this.offset)
      } finally {
        closeSync(fd)
      }
    } catch {
      return // briefly locked (a virus scanner, the writer rotating it): the next tick retries, and this runs in a timer
    }
    this.offset += read

    const all = Buffer.concat([this.pending, buf.subarray(0, read)])
    const lastNewline = all.lastIndexOf(0x0a)
    if (lastNewline === -1) {
      this.pending = all
      return
    }
    this.pending = all.subarray(lastNewline + 1)
    const lines = all
      .subarray(0, lastNewline)
      .toString('utf8')
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter((l) => l.length > 0)
    if (lines.length) this.onLines(lines)
  }

  private skipPartialFirstLine(): void {
    // We landed mid-file: drop the fragment up to the next newline so no line starts halfway.
    try {
      const fd = openSync(this.path, 'r')
      try {
        const probe = Buffer.alloc(RECENT_BYTES)
        const n = readSync(fd, probe, 0, RECENT_BYTES, this.offset)
        const nl = probe.subarray(0, n).indexOf(0x0a)
        if (nl !== -1) this.offset += nl + 1
      } finally {
        closeSync(fd)
      }
    } catch {
      /* the next poll will resynchronise */
    }
  }
}
