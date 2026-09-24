import { closeSync, openSync, readSync, statSync } from 'node:fs'

/**
 * What the elevated helper reports, one JSON object per line in a file the app creates and follows
 * (helper/internal/setup/report.go writes it — the shapes must agree). A file, not a pipe: an elevated
 * process cannot share its output with the unelevated one that started it.
 */
export type SetupEvent =
  | { kind: 'step'; step: number; state: 'active' | 'done' }
  | { kind: 'failed'; step: number; message: string }
  /** Seamless update: the new version is fully copied beside the old one and nothing is replaced yet. */
  | { kind: 'staged' }

/** Anything that is not one of the two shapes is ignored: a half-written line, or a future event. */
export function parseProgressLine(line: string): SetupEvent | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (typeof o['failed'] === 'object' && o['failed'] !== null) {
    const f = o['failed'] as Record<string, unknown>
    if (typeof f['step'] === 'number' && typeof f['message'] === 'string') {
      return { kind: 'failed', step: f['step'], message: f['message'] }
    }
    return null
  }
  if (o['staged'] === true) return { kind: 'staged' }
  if (typeof o['step'] === 'number' && (o['state'] === 'active' || o['state'] === 'done')) {
    return { kind: 'step', step: o['step'], state: o['state'] }
  }
  return null
}

/** Reads what has been appended since the last call; a line still being written waits for its newline. */
export class ProgressFollower {
  private offset = 0
  /** Bytes, not text: a read can end in the middle of a multi-byte character. */
  private pending: Buffer = Buffer.alloc(0)

  constructor(private readonly path: string) {}

  read(): SetupEvent[] {
    let size: number
    try {
      size = statSync(this.path).size
    } catch {
      return []
    }
    if (size <= this.offset) return []
    const fd = openSync(this.path, 'r')
    try {
      const buffer = Buffer.alloc(size - this.offset)
      const n = readSync(fd, buffer, 0, buffer.length, this.offset)
      this.offset += n
      this.pending = Buffer.concat([this.pending, buffer.subarray(0, n)])
    } finally {
      closeSync(fd)
    }
    const end = this.pending.lastIndexOf(0x0a)
    if (end < 0) return []
    const complete = this.pending.subarray(0, end).toString('utf8')
    this.pending = this.pending.subarray(end + 1)
    return complete.split('\n').map(parseProgressLine).filter((e): e is SetupEvent => e !== null)
  }
}
