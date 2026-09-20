import { basename, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings: () => {} }
}))

const registry: { dir: string | null } = { dir: null }
vi.mock('../src/main/setup/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/setup/mode')>()),
  readInstalledDir: () => Promise.resolve(registry.dir)
}))

const { helperPath, loginExe, readAppOptions } = await import('../src/main/appOptions')

beforeEach(() => {
  registry.dir = null
})

describe('helperPath', () => {
  it('is in Program Files whatever folder the application itself went to', () => {
    expect(helperPath({ ProgramFiles: 'D:\\Program Files' } as NodeJS.ProcessEnv)).toBe(
      join('D:\\Program Files\\AmnesiaWG', 'awg-helper.exe')
    )
  })
})

describe('loginExe', () => {
  it('is the installed copy, not the one running', async () => {
    // Right after an install the running process is still the installer's temporary copy, and a login
    // item pointing into %TEMP% breaks the first time Windows clears it.
    registry.dir = 'D:\\Programs\\AmnesiaWG'
    expect(await loginExe()).toBe(join('D:\\Programs\\AmnesiaWG', basename(process.execPath)))
  })

  it('falls back to the running one when nothing is registered', async () => {
    expect(await loginExe()).toBe(process.execPath)
  })
})

describe('readAppOptions', () => {
  it('says nothing is supported off Windows, so the tab can stay away', async () => {
    // The test process is not win32, which is exactly the case being checked.
    expect(await readAppOptions()).toEqual({ supported: false, autoStart: false })
  })
})
