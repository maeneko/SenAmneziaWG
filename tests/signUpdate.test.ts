import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UPDATE_KEYS, updateMessage, verifyUpdate } from '../src/main/update/signature'

const SCRIPT = join(__dirname, '..', 'scripts', 'sign-update.mjs')

const run = (args: string[], key?: string) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, UPDATE_SIGNING_KEY: key ?? '' } })

describe('scripts/sign-update.mjs against signature.ts', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'senawg-sign-'))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  const newKey = () => {
    const { privateKey } = crypto.generateKeyPairSync('ed25519')
    return {
      secret: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
      pub: crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')
    }
  }

  it('signs each installer the way the application checks it', async () => {
    const files: Record<string, 'windows' | 'linux' | 'macos'> = {
      'SenAWG-0.8.0-setup.exe': 'windows',
      'SenAWG-0.8.0-linux-x64.run': 'linux',
      'SenAWG-0.8.0-arm64.dmg': 'macos'
    }
    for (const name of Object.keys(files)) await writeFile(join(dir, name), `body of ${name}`)
    await writeFile(join(dir, 'SHA256SUMS'), 'not an installer')
    const { secret, pub } = newKey()

    const r = run([dir, '--skip-app-check'], secret)
    expect(r.status, r.stderr).toBe(0)
    expect((await readdir(dir)).filter((f) => f.endsWith('.sig')).sort()).toEqual(Object.keys(files).map((f) => `${f}.sig`).sort())

    for (const [name, os] of Object.entries(files)) {
      const body = await readFile(join(dir, name))
      const sig = await readFile(join(dir, `${name}.sig`), 'utf8')
      const sha = crypto.createHash('sha256').update(body).digest('hex')
      expect(verifyUpdate(updateMessage(os, name, body.length, sha), sig, [pub])).toBe(true)
      // The same signature says nothing about another system, another name or another file.
      expect(verifyUpdate(updateMessage(os === 'linux' ? 'windows' : 'linux', name, body.length, sha), sig, [pub])).toBe(false)
      expect(verifyUpdate(updateMessage(os, name.replace('0.8.0', '0.7.0'), body.length, sha), sig, [pub])).toBe(false)
      expect(verifyUpdate(updateMessage(os, name, body.length + 1, sha), sig, [pub])).toBe(false)
      // …nor is it accepted with the application's own key.
      expect(verifyUpdate(updateMessage(os, name, body.length, sha), sig)).toBe(false)
    }
  })

  it('refuses a key the application does not know, or no key at all', async () => {
    await writeFile(join(dir, 'SenAWG-0.8.0-setup.exe'), 'MZ')
    const unknown = run([dir], newKey().secret)
    expect(unknown.status).toBe(1)
    expect(unknown.stderr).toMatch(/нет в UPDATE_KEYS/)
    expect(run([dir]).stderr).toMatch(/нет UPDATE_SIGNING_KEY/)
    expect(await readdir(dir)).toEqual(['SenAWG-0.8.0-setup.exe'])
  })

  it('keygen writes a private key only its owner can read, and never over an existing one', async () => {
    const file = join(dir, 'update.key')
    const r = run(['keygen', file])
    expect(r.status, r.stderr).toBe(0)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    const pub = /Открытый \(в UPDATE_KEYS\): (\S+)/.exec(r.stdout)?.[1]
    expect(pub).toMatch(/^[A-Za-z0-9+/]{43}=$/)
    expect(run(['keygen', file]).status).toBe(1)
  })

  it('the application carries at least one well-formed key', () => {
    expect(UPDATE_KEYS.length).toBeGreaterThan(0)
    for (const k of UPDATE_KEYS) expect(Buffer.from(k, 'base64')).toHaveLength(32)
  })
})
