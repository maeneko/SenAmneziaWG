import { spawn } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ERROR_CANCELLED, elevationScript, quoteWinArg } from '../src/main/setup/elevate'
import {
  defaultInstallDir,
  isSetupMode,
  isUpdateFromApp,
  parseInstallJSON,
  parseRegQuery,
  seamlessOf,
  updateFromAppArgs,
  waitForExit,
  waitPidOf
} from '../src/main/setup/mode'
import { ProgressFollower, parseProgressLine } from '../src/main/setup/progress'

describe('isSetupMode', () => {
  it('is the unpacked installer, or --setup by hand', () => {
    expect(isSetupMode(['SenAWG.exe'], {})).toBe(false)
    expect(isSetupMode(['SenAWG.exe', '--setup'], {})).toBe(true)
    expect(isSetupMode(['SenAWG.exe'], { PORTABLE_EXECUTABLE_FILE: 'C:\\Users\\u\\Downloads\\SenAWG-0.1.0-setup.exe' })).toBe(true)
  })

  it('is also the Linux .run stub (scripts/make-run.sh sets SENAWG_RUN_FILE)', () => {
    expect(isSetupMode(['senawg'], { SENAWG_RUN_FILE: '/home/u/Downloads/SenAWG-0.1.0-linux-x64.run' })).toBe(true)
  })

  it('puts the express install under Program Files', () => {
    expect(defaultInstallDir({})).toBe('C:\\Program Files\\SenAWG')
    expect(defaultInstallDir({ ProgramFiles: 'D:\\PF' })).toBe('D:\\PF\\SenAWG')
  })

  it('is fixed at /opt/SenAWG on Linux — the installer offers no other choice there', () => {
    expect(defaultInstallDir({}, 'linux')).toBe('/opt/SenAWG')
  })
})

describe('parseInstallJSON', () => {
  it('reads helper/setup_linux.go’s install.json', () => {
    expect(parseInstallJSON('{"appPath":"/opt/SenAWG","version":"0.6.0"}')).toBe('/opt/SenAWG')
  })

  it('is null for anything else', () => {
    expect(parseInstallJSON('{}')).toBeNull()
    expect(parseInstallJSON('not json')).toBeNull()
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
  it('reads «staged»: the new version is copied beside the old one', () => {
    expect(parseProgressLine('{"staged":true}')).toEqual({ kind: 'staged' })
    expect(parseProgressLine('{"staged":false}')).toBeNull()
  })

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

describe('the seamless update', () => {
  const seamless = { handoff: '/tmp/senawg-update-x', bounds: { x: 10.4, y: 20, width: 420, height: 780 }, reconnect: 'abc-1' }

  it('carries the handoff folder, where the window was and what to reconnect', () => {
    const argv = ['SenAWG.exe', ...updateFromAppArgs(4242, seamless)]
    expect(isUpdateFromApp(argv)).toBe(true)
    expect(waitPidOf(argv)).toBe(4242)
    expect(seamlessOf(argv)).toEqual({ ...seamless, bounds: { x: 10, y: 20, width: 420, height: 780 }, maximized: false })
  })

  it('leaves out what it does not have', () => {
    const argv = ['SenAWG.exe', ...updateFromAppArgs(1, { handoff: '/h', bounds: null, reconnect: null })]
    expect(seamlessOf(argv)).toEqual({ handoff: '/h', bounds: null, reconnect: null, maximized: false })
  })

  it('says when the window was maximized', () => {
    const argv = ['SenAWG.exe', ...updateFromAppArgs(1, { handoff: '/h', bounds: null, reconnect: null, maximized: true })]
    expect(seamlessOf(argv)?.maximized).toBe(true)
  })

  it('is not seamless without --seamless: the older application starts the older, visible update', () => {
    // What every application that predates this one runs. It must keep opening as an ordinary update.
    const legacy = ['SenAWG.exe', '--update-from-app', '--wait-pid=4242']
    expect(isUpdateFromApp(legacy)).toBe(true)
    expect(waitPidOf(legacy)).toBe(4242)
    expect(seamlessOf(legacy)).toBeNull()
    expect(updateFromAppArgs(4242)).toEqual(['--update-from-app', '--wait-pid=4242'])
  })

  it('needs its handoff folder, and ignores window bounds that make no sense', () => {
    expect(seamlessOf(['x', '--update-from-app', '--seamless'])).toBeNull()
    expect(seamlessOf(['x', '--seamless', '--handoff=/h'])).toBeNull() // not started by an application
    const odd = seamlessOf(['x', '--update-from-app', '--seamless', '--handoff=/h', '--bounds=1,2,0,780'])
    expect(odd?.bounds).toBeNull()
    expect(seamlessOf(['x', '--update-from-app', '--seamless', '--handoff=/h', '--bounds=a,b,c,d'])?.bounds).toBeNull()
  })
})

describe('update started from the application', () => {
  it('passes its pid and is recognised on the other side', () => {
    const argv = ['SenAWG.exe', ...updateFromAppArgs(4242)]
    expect(isUpdateFromApp(argv)).toBe(true)
    expect(waitPidOf(argv)).toBe(4242)
    expect(isUpdateFromApp(['SenAWG.exe'])).toBe(false)
    expect(waitPidOf(['SenAWG.exe'])).toBeNull()
    expect(waitPidOf(['SenAWG.exe', '--wait-pid=abc'])).toBeNull()
    expect(waitPidOf(['SenAWG.exe', '--wait-pid=0'])).toBeNull()
  })

  it('waits for the application to exit, and no longer than it has to', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'])
    const started = Date.now()
    await waitForExit(child.pid ?? null, 5000, 20)
    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('gives up waiting after the timeout', async () => {
    const started = Date.now()
    await waitForExit(process.pid, 150, 20)
    expect(Date.now() - started).toBeLessThan(1000)
  })
})
