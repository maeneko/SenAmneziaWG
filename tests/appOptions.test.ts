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

const { canUninstall, helperPath, loginExe, readAppOptions, supported } = await import('../src/main/appOptions')

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

describe('supported', () => {
  it('is both desktops: autostart and auto-connect mean the same on either', () => {
    expect(supported('win32')).toBe(true)
    expect(supported('darwin')).toBe(true)
    expect(supported('linux')).toBe(false)
  })
})

describe('canUninstall', () => {
  it('is Windows alone — a macOS application is thrown away by hand, with nothing left behind', () => {
    expect(canUninstall('win32')).toBe(true)
    expect(canUninstall('darwin')).toBe(false)
  })
})

describe('readAppOptions', () => {
  it('offers the switches but no uninstalling here', async () => {
    // The test process is darwin, which is exactly the case being checked.
    expect(await readAppOptions()).toEqual({ supported: true, canUninstall: false, autoStart: false })
  })
})
