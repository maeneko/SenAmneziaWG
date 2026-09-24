import { describe, expect, it } from 'vitest'
import { Logger } from '../src/main/logger'
import { createBackend } from '../src/main/tunnel/createBackend'
import { LinuxHelperController } from '../src/main/tunnel/linuxHelperController'
import { MacosScriptController } from '../src/main/tunnel/macosScriptController'
import { WindowsHelperController } from '../src/main/tunnel/windowsHelperController'

const options = () => ({
  resources: '/res',
  userData: '/data',
  packaged: false,
  logger: new Logger(),
  diagnostics: () => false,
  dnsFor: () => [],
  daemonLines: () => {}
})

describe('createBackend', () => {
  it('runs the macOS script helper on macOS, with the manager’s own connectivity probe', () => {
    const backend = createBackend(options(), 'darwin')
    expect(backend.controller).toBeInstanceOf(MacosScriptController)
    expect(backend.probe).toBeUndefined()
  })

  it('talks to the service on Windows, with probes that ask the service', () => {
    const backend = createBackend(options(), 'win32')
    expect(backend.controller).toBeInstanceOf(WindowsHelperController)
    expect(backend.probe).toBeTypeOf('function')
  })

  it('has no packet capture on Windows', () => {
    expect(createBackend(options(), 'win32').controller.readCapture).toBeUndefined()
  })

  it('talks to the service on Linux too, with probes that ask the service', () => {
    const backend = createBackend(options(), 'linux')
    expect(backend.controller).toBeInstanceOf(LinuxHelperController)
    expect(backend.probe).toBeTypeOf('function')
  })

  it('has no packet capture on Linux', () => {
    expect(createBackend(options(), 'linux').controller.readCapture).toBeUndefined()
  })

  it('refuses a platform it has no engine for', () => {
    expect(() => createBackend(options(), 'freebsd')).toThrow(/macOS, Windows и Linux/)
  })
})
