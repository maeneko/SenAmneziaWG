import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ERROR_CANCELLED, elevationScript, quoteWinArg } from '../src/main/setup/elevate'
import { defaultInstallDir, isSetupMode, parseRegQuery } from '../src/main/setup/mode'
import { ProgressFollower, parseProgressLine } from '../src/main/setup/progress'

describe('isSetupMode', () => {
  it('is the unpacked installer, or --setup by hand', () => {
    expect(isSetupMode(['SenAWG.exe'], {})).toBe(false)
    expect(isSetupMode(['SenAWG.exe', '--setup'], {})).toBe(true)
    expect(isSetupMode(['SenAWG.exe'], { PORTABLE_EXECUTABLE_FILE: 'C:\\Users\\u\\Downloads\\SenAWG-0.1.0-setup.exe' })).toBe(true)
  })

  it('puts the express install under Program Files', () => {
    expect(defaultInstallDir({})).toBe('C:\\Program Files\\SenAWG')
    expect(defaultInstallDir({ ProgramFiles: 'D:\\PF' })).toBe('D:\\PF\\SenAWG')
  })
})

describe('parseRegQuery', () => {
  it('takes the whole value, spaces included', () => {
    const out = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\SenAWG\r\n    AppPath    REG_SZ    D:\\My Programs\\SenAWG\r\n\r\n'
    expect(parseRegQuery(out)).toBe('D:\\My Programs\\SenAWG')
  })

  it('finds nothing in an error', () => {
    expect(parseRegQuery('ERROR: The system was unable to find the specified registry key or value.')).toBeNull()
  })
})

describe('quoteWinArg', () => {
  it('quotes paths with spaces and keeps a trailing backslash from eating the quote', () => {
    expect(quoteWinArg('C:\\Program Files\\SenAWG')).toBe('"C:\\Program Files\\SenAWG"')
    expect(quoteWinArg('D:\\Programs\\')).toBe('"D:\\Programs\\\\"')
  })

  it('escapes an embedded quote and the backslashes before it', () => {
    expect(quoteWinArg('a"b')).toBe('"a\\"b"')
    expect(quoteWinArg('a\\"b')).toBe('"a\\\\\\"b"')
  })
})

describe('elevationScript', () => {
  const script = elevationScript("C:\\It's here\\awg-helper.exe", ['setup', '--app-to', 'D:\\My Apps\\SenAWG'])

  it('asks for the consent prompt and waits for the result', () => {
    expect(script).toContain('-Verb RunAs')
    expect(script).toContain('-Wait')
    expect(script).toContain('exit $p.ExitCode')
  })

  it('doubles a single quote inside the PowerShell string', () => {
    expect(script).toContain("-FilePath 'C:\\It''s here\\awg-helper.exe'")
  })

  it('separates a declined prompt from every other failure', () => {
    expect(script).toContain(`NativeErrorCode -eq ${ERROR_CANCELLED}`)
    expect(ERROR_CANCELLED).toBe(1223)
  })
})

describe('parseProgressLine', () => {
  it('reads the two shapes the helper writes', () => {
    expect(parseProgressLine('{"step":1,"state":"active"}')).toEqual({ kind: 'step', step: 1, state: 'active' })
    expect(parseProgressLine('{"step":2,"state":"done"}')).toEqual({ kind: 'step', step: 2, state: 'done' })
    expect(parseProgressLine('{"failed":{"step":1,"message":"нет доступа"}}')).toEqual({
      kind: 'failed',
      step: 1,
      message: 'нет доступа'
    })
  })

  it('ignores whatever else', () => {
    for (const line of ['', 'не json', '[]', 'null', '{"step":1}', '{"step":1,"state":"paused"}', '{"failed":{"step":1}}']) {
      expect(parseProgressLine(line)).toBeNull()
    }
  })
})

describe('ProgressFollower', () => {
  let dir = ''
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('hands over each event once, and waits for a line to be finished', () => {
    dir = mkdtempSync(join(tmpdir(), 'awg-progress-'))
    const path = join(dir, 'p.jsonl')
    const follower = new ProgressFollower(path)
    expect(follower.read()).toEqual([]) // the file does not exist yet

    writeFileSync(path, '{"step":0,"state":"active"}\n{"step":0,"sta')
    expect(follower.read()).toEqual([{ kind: 'step', step: 0, state: 'active' }])

    appendFileSync(path, 'te":"done"}\n')
    expect(follower.read()).toEqual([{ kind: 'step', step: 0, state: 'done' }])
    expect(follower.read()).toEqual([])
  })

  it('reads non-ASCII messages that arrive in one piece', () => {
    dir = mkdtempSync(join(tmpdir(), 'awg-progress-'))
    const path = join(dir, 'p.jsonl')
    writeFileSync(path, '{"failed":{"step":1,"message":"Служба не запустилась"}}\n')
    expect(new ProgressFollower(path).read()).toEqual([{ kind: 'failed', step: 1, message: 'Служба не запустилась' }])
  })
})

describe('ProgressFollower and multi-byte text', () => {
  it('does not break a character that arrives in two reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'awg-progress-'))
    try {
      const path = join(dir, 'p.jsonl')
      const line = Buffer.from('{"failed":{"step":1,"message":"Ошибка"}}\n', 'utf8')
      const cut = line.indexOf(0xd0) + 1 // between the two bytes of «О»
      writeFileSync(path, line.subarray(0, cut))
      const follower = new ProgressFollower(path)
      expect(follower.read()).toEqual([])
      appendFileSync(path, line.subarray(cut))
      expect(follower.read()).toEqual([{ kind: 'failed', step: 1, message: 'Ошибка' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
