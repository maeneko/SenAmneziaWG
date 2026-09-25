import { describe, expect, it } from 'vitest'
import { Logger } from '../src/main/logger'
import { createBackend } from '../src/main/tunnel/createBackend'
import { LinuxHelperController } from '../src/main/tunnel/linuxHelperController'
import { MacosScriptController } from '../src/main/tunnel/macosScriptController'
import { MacosServiceController } from '../src/main/tunnel/macosServiceController'
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
  it('talks to the SenAWG service in a packaged macOS app, with the manager’s own connectivity probe', () => {
    const backend = createBackend({ ...options(), packaged: true }, 'darwin')
    expect(backend.controller).toBeInstanceOf(MacosServiceController)
    expect(backend.probe).toBeUndefined()
  })

  it('keeps the admin prompt per connection in macOS development (unless SENAWG_MAC_SERVICE=1)', () => {
    const backend = createBackend(options(), 'darwin')
    expect(backend.controller).toBeInstanceOf(process.env['SENAWG_MAC_SERVICE'] === '1' ? MacosServiceController : MacosScriptController)
  })

  it('has packet capture on macOS, either way', () => {
    expect(createBackend({ ...options(), packaged: true }, 'darwin').controller.readCapture).toBeTypeOf('function')
    expect(createBackend(options(), 'darwin').controller.readCapture).toBeTypeOf('function')
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
