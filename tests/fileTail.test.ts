import { appendFileSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Windows can report inode 0 for a file, and a virus scanner can hold it open for a moment.
let zeroInode = false
let locked = false
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>()
  return {
    ...real,
    statSync: (p: string) => {
      const st = real.statSync(p)
      return zeroInode ? ({ ...st, ino: 0, size: st.size } as typeof st) : st
    },
    openSync: (...args: Parameters<typeof real.openSync>) => {
      if (locked) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      return real.openSync(...args)
    }
  }
})
const { FileTail } = await import('../src/main/tunnel/fileTail')

describe('FileTail on Windows semantics', () => {
  let dir: string
  let file: string
  let got: string[]
  const tail = (): InstanceType<typeof FileTail> => new FileTail(file, (l) => got.push(...l), 1_000_000)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'awgtail-win-'))
    file = join(dir, 'daemon.log')
    got = []
    zeroInode = false
    locked = false
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('re-reads from the top after the file is truncated, without an inode to go by', () => {
    zeroInode = true
    writeFileSync(file, 'a long first session line\nanother long line\n')
    const t = tail()
    t.start('end')
    writeFileSync(file, 'new\n') // the helper starts a fresh log for the next connection
    t.poll()
    expect(got).toEqual(['new'])
    t.stop()
  })

  it('keeps following after that', () => {
    zeroInode = true
    writeFileSync(file, 'old old old old\n')
    const t = tail()
    t.start('end')
    writeFileSync(file, 'x\n')
    t.poll()
    appendFileSync(file, 'y\n')
    t.poll()
    expect(got).toEqual(['x', 'y'])
    t.stop()
  })

  it('skips a tick while the file is locked instead of throwing, then catches up', () => {
    writeFileSync(file, '')
    const t = tail()
    t.start('end')
    appendFileSync(file, 'one\ntwo\n')
    locked = true
    expect(() => t.poll()).not.toThrow()
    expect(got).toEqual([])
    locked = false
    t.poll()
    expect(got).toEqual(['one', 'two'])
    t.stop()
  })

  it('tracks the inode of a file that appears after start, so a later replacement is noticed', () => {
    const t = tail()
    t.start('end') // no file yet
    writeFileSync(file, 'a\n')
    t.poll()
    unlinkSync(file)
    writeFileSync(file, 'brand new file that is larger than the first one\nsecond\n')
    t.poll()
    expect(got).toEqual(['a', 'brand new file that is larger than the first one', 'second'])
    t.stop()
  })
})
