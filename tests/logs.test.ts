import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Logger, MAX_LOG_ENTRIES, formatEntry, parseDaemonLine, redact } from '../src/main/logger'
import { FileTail } from '../src/main/tunnel/fileTail'
import { splitHelperOutput } from '../src/main/tunnel/helperOutput'

describe('redact', () => {
  const b64 = Buffer.alloc(32, 7).toString('base64')
  const hex = Buffer.alloc(32, 7).toString('hex')

  it('hides base64 and hex WireGuard keys', () => {
    expect(redact(`private_key=${hex} PublicKey = ${b64}`)).toBe('private_key=[ключ скрыт] PublicKey = [ключ скрыт]')
  })

  it('leaves ordinary text and short hex alone', () => {
    expect(redact('Туннель utun4 поднят, MTU 1280, peer(abcd…wxyz)')).toBe('Туннель utun4 поднят, MTU 1280, peer(abcd…wxyz)')
  })
})

describe('Logger', () => {
  it('assigns increasing ids and notifies subscribers with only the new entries', () => {
    const log = new Logger()
    const seen: number[][] = []
    log.subscribe((e) => seen.push(e.map((x) => x.id)))
    log.info('a')
    log.addMany([
      { level: 'warn', source: 'tunnel', message: 'b' },
      { level: 'error', source: 'tunnel', message: 'c' }
    ])
    expect(seen).toEqual([[1], [2, 3]])
    expect(log.list().map((e) => e.message)).toEqual(['a', 'b', 'c'])
  })

  it('caps the buffer, dropping the oldest', () => {
    const log = new Logger()
    for (let i = 0; i < MAX_LOG_ENTRIES + 5; i++) log.info(`m${i}`)
    const all = log.list()
    expect(all).toHaveLength(MAX_LOG_ENTRIES)
    expect(all[0].message).toBe('m5')
  })

  it('filters by source, clears, and redacts on the way in', () => {
    const log = new Logger()
    log.info('app line')
    log.add('info', 'tunnel', `key ${Buffer.alloc(32, 1).toString('base64')}`)
    expect(log.list('tunnel')).toHaveLength(1)
    expect(log.list('tunnel')[0].message).toBe('key [ключ скрыт]')
    log.clear()
    expect(log.list()).toEqual([])
  })

  it('stops notifying after unsubscribe', () => {
    const log = new Logger()
    let n = 0
    const off = log.subscribe(() => n++)
    log.info('x')
    off()
    log.info('y')
    expect(n).toBe(1)
  })

  it('formats an entry for the clipboard', () => {
    const line = formatEntry({ id: 1, ts: new Date(2026, 8, 19, 12, 3, 9).getTime(), level: 'warn', source: 'app', message: 'hello' })
    expect(line).toBe('2026-09-19 12:03:09 [app] WARN  hello')
  })
})

describe('parseDaemonLine', () => {
  it.each([
    ['ERROR: (utun4) 2026/09/19 12:00:00 Failed to send', 'error', 'Failed to send'],
    ['WARNING: something odd', 'warn', 'something odd'],
    ['DEBUG: (utun4) 2026/09/19 12:00:01 Sending keepalive packet', 'debug', 'Sending keepalive packet'],
    ['VERBOSE: hi', 'debug', 'hi'],
    ['INFO: ready', 'info', 'ready'],
    ['plain text without a level', 'info', 'plain text without a level']
  ])('%s', (line, level, message) => {
    expect(parseDaemonLine(line)).toEqual({ level, source: 'tunnel', message })
  })
})

describe('FileTail', () => {
  let dir: string
  let file: string
  let got: string[]
  const tail = (): FileTail => new FileTail(file, (l) => got.push(...l), 1_000_000)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'awgtail-'))
    file = join(dir, 'daemon.log')
    got = []
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("start('end') skips existing content and emits only what is appended", () => {
    writeFileSync(file, 'old 1\nold 2\n')
    const t = tail()
    t.start('end')
    t.poll()
    expect(got).toEqual([])
    appendFileSync(file, 'new 1\nnew 2\n')
    t.poll()
    expect(got).toEqual(['new 1', 'new 2'])
    t.stop()
  })

  it('holds back a partial line until it is finished', () => {
    writeFileSync(file, '')
    const t = tail()
    t.start('end')
    appendFileSync(file, 'complete\npart')
    t.poll()
    expect(got).toEqual(['complete'])
    appendFileSync(file, 'ial\n')
    t.poll()
    expect(got).toEqual(['complete', 'partial'])
    t.stop()
  })

  it('reads a replaced file (new inode) from the top even if it is larger than the old one', () => {
    writeFileSync(file, 'x\n')
    const t = tail()
    t.start('end')
    unlinkSync(file)
    writeFileSync(file, 'first\nsecond\nthird\nfourth\n')
    t.poll()
    expect(got).toEqual(['first', 'second', 'third', 'fourth'])
    t.stop()
  })

  it('recovers from truncation in place', () => {
    writeFileSync(file, 'aaaaaaaaaa\nbbbbbbbbbb\n')
    const t = tail()
    t.start('end')
    truncateSync(file, 0)
    appendFileSync(file, 'fresh\n')
    t.poll()
    expect(got).toEqual(['fresh'])
    t.stop()
  })

  it('picks up a file that appears after start, and ignores a missing one', () => {
    const t = tail()
    t.start('end')
    t.poll()
    expect(got).toEqual([])
    writeFileSync(file, 'born\n')
    t.poll()
    expect(got).toEqual(['born'])
    t.stop()
  })

  it("start('recent') begins on a line boundary near the end", () => {
    const line = 'y'.repeat(99) + '\n'
    writeFileSync(file, line.repeat(200) + 'tail\n')
    const t = tail()
    t.start('recent')
    t.poll()
    expect(got.length).toBeGreaterThan(1)
    expect(got.length).toBeLessThan(200)
    expect(got.every((l) => l === 'y'.repeat(99) || l === 'tail')).toBe(true)
    expect(got.at(-1)).toBe('tail')
    t.stop()
  })

  it('does not split multi-byte characters across reads', () => {
    writeFileSync(file, '')
    const t = tail()
    t.start('end')
    const bytes = Buffer.from('Туннель\n', 'utf8')
    appendFileSync(file, bytes.subarray(0, 3))
    t.poll()
    appendFileSync(file, bytes.subarray(3))
    t.poll()
    expect(got).toEqual(['Туннель'])
    t.stop()
  })
})

describe('splitHelperOutput', () => {
  it('separates warnings, drops IFACE=, and copes with osascript CR line endings', () => {
    const out = splitHelperOutput('warning: IPv6-маршрут не добавлен\rIFACE=utun7\rwarning: DNS не изменён\r')
    expect(out.warnings).toEqual(['IPv6-маршрут не добавлен', 'DNS не изменён'])
    expect(out.rest).toBe('')
  })

  it('keeps the failure message', () => {
    const out = splitHelperOutput('warning: x\nИнтерфейс не поднялся за 10 секунд\n')
    expect(out.warnings).toEqual(['x'])
    expect(out.rest).toBe('Интерфейс не поднялся за 10 секунд')
  })
})
