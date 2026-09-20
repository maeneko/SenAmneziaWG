import { createServer, type Server } from 'node:net'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Logger } from '../src/main/logger'
import { createMacosBackend } from '../src/main/tunnel/macosBackend'
import { createWindowsBackend } from '../src/main/tunnel/windowsBackend'

/** The engine line «Об AmnesiaWG» shows, and the one the journal gets at start-up. */
const options = () => ({
  resources: resolve('resources'),
  userData: '/tmp/awg-test-userdata',
  packaged: false,
  logger: new Logger(),
  diagnostics: () => false,
  dnsFor: () => []
})

describe('macOS backend describe', () => {
  // Runs the daemon that scripts/build-amneziawg.sh put in resources/bin.
  it.skipIf(process.platform !== 'darwin')('reports the bundled daemon and its version', async () => {
    const info = await createMacosBackend(options()).describe()
    expect(info.engine).toMatch(/^amneziawg-go \d+\.\d+\./)
    expect(info.detail).toMatch(/^встроенный: .*resources\/bin\/amneziawg-go$/)
    expect(info.warning).toBeUndefined()
  })

  it('tells the user what to do when a packaged build has no daemon inside it', async () => {
    const backend = createMacosBackend({ ...options(), resources: '/nowhere', packaged: true })
    await expect(backend.describe()).rejects.toThrow(/переустановите/)
  })

  // A machine with amneziawg-go installed (brew, /usr/local) is a development fallback, never a release.
  it.skipIf(process.platform !== 'darwin' || !existsSync('/usr/local/bin/amneziawg-go'))(
    'warns when a system copy is being used instead of the bundled one',
    async () => {
      const info = await createMacosBackend({ ...options(), resources: '/nowhere' }).describe()
      expect(info.detail).toMatch(/^системный: /)
      expect(info.warning).toMatch(/npm run build:awg/)
    }
  )
})

describe('Windows backend describe', () => {
  let dir: string
  let server: Server | null = null

  const fakeService = (reply: object): string => {
    // A unix socket stands in for the helper's named pipe.
    const path = process.platform === 'win32' ? String.raw`\\.\pipe\awg-engine-${process.pid}` : join(dir, 'h.sock')
    server = createServer((sock) => {
      sock.on('data', () => sock.end(JSON.stringify(reply) + '\n'))
      sock.on('error', () => {})
    }).listen(path)
    return path
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'awg-engine-'))
  })
  afterEach(() => {
    server?.close()
    server = null
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports the daemon compiled into the service', async () => {
    const pipe = fakeService({ ok: true, protocol: 1, helper: '0.1.0', awgGo: 'v3.1.20260828' })
    expect(await createWindowsBackend(options(), pipe).describe()).toEqual({
      engine: 'amneziawg-go v3.1.20260828',
      detail: 'в службе AmnesiaWG 0.1.0'
    })
  })

  it('says the service is not running when nothing answers', async () => {
    const backend = createWindowsBackend(options(), join(dir, 'missing.sock'))
    await expect(backend.describe()).rejects.toThrow(/Служба AmnesiaWG не запущена/)
  })

  it('refuses a service of another protocol version', async () => {
    const pipe = fakeService({ ok: true, protocol: 99, helper: '9.9.9', awgGo: 'v3.1.20260828' })
    await expect(createWindowsBackend(options(), pipe).describe()).rejects.toThrow(/другой версии/)
  })
})
