import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedTunnel } from '../src/main/config/wgConfig'

const env = { dir: '', available: true, backend: 'gnome_libsecret' }
vi.mock('electron', () => ({
  app: { getPath: () => env.dir },
  safeStorage: {
    isEncryptionAvailable: () => env.available,
    getSelectedStorageBackend: () => env.backend,
    encryptString: (s: string) => Buffer.from(`sealed:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^sealed:/, '')
  }
}))

const { loadSecrets, removeTunnel, saveTunnel, useKeyVault } = await import('../src/main/store')

const parsed = (id: string): ParsedTunnel =>
  ({ tunnel: { id, name: id }, secrets: { privateKey: 'PRIV', presharedKey: 'PSK' } }) as unknown as ParsedTunnel

const vault = { put: vi.fn(async () => {}), delete: vi.fn(async () => {}) }
const platform = process.platform

beforeEach(() => {
  env.dir = mkdtempSync(join(tmpdir(), 'awg-store-'))
  env.available = true
  env.backend = 'gnome_libsecret'
  vault.put.mockClear()
  vault.delete.mockClear()
  useKeyVault(vault)
  Object.defineProperty(process, 'platform', { value: 'linux' })
})

afterEach(() => {
  rmSync(env.dir, { recursive: true, force: true })
  Object.defineProperty(process, 'platform', { value: platform })
  useKeyVault(null)
})

describe('store: where the keys go', () => {
  it('a real keyring: sealed by safeStorage, the service is not asked', async () => {
    expect(await saveTunnel(parsed('a'))).toBe('keyring')
    expect(vault.put).not.toHaveBeenCalled()
    expect(loadSecrets('a')).toEqual({ privateKey: 'PRIV', presharedKey: 'PSK' })
  })

  it("Chromium's basic_text is not encryption: the keys go to the service and are not on disk here", async () => {
    env.backend = 'basic_text'
    expect(await saveTunnel(parsed('b'))).toBe('service')
    expect(vault.put).toHaveBeenCalledWith('b', { privateKey: 'PRIV', presharedKey: 'PSK' })
    expect(readFileSync(join(env.dir, 'secrets.json'), 'utf8')).not.toContain('PRIV')
    expect(loadSecrets('b')).toEqual({ privateKey: '', heldByService: true })
  })

  it('no keyring at all: the service too', async () => {
    env.available = false
    expect(await saveTunnel(parsed('c'))).toBe('service')
  })

  it('no keyring and no service (macOS/Windows never get here): refuses, as before', async () => {
    env.available = false
    useKeyVault(null)
    await expect(saveTunnel(parsed('d'))).rejects.toThrow(/недоступно/)
  })

  it('a service failure is not a saved server', async () => {
    env.available = false
    vault.put.mockRejectedValueOnce(new Error('служба не запустилась'))
    await expect(saveTunnel(parsed('e'))).rejects.toThrow(/служба/)
    expect(loadSecrets('e')).toBeNull()
  })

  it('removing a server forgets the service copy only when the service had one', async () => {
    await saveTunnel(parsed('f'))
    env.available = false
    await saveTunnel(parsed('g'))
    await removeTunnel('f')
    expect(vault.delete).not.toHaveBeenCalled()
    await removeTunnel('g')
    expect(vault.delete).toHaveBeenCalledWith('g')
  })
})
