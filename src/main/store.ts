import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Tunnel } from '../shared/types'
import type { ParsedTunnel, TunnelSecrets } from './config/wgConfig'

type SecretsFile = Record<string, { privateKey: string; presharedKey?: string }>

const dir = (): string => app.getPath('userData')
const tunnelsPath = (): string => join(dir(), 'tunnels.json')
const secretsPath = (): string => join(dir(), 'secrets.json')

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

// Write-then-rename so a crash never leaves a half-written file.
function writeJson(path: string, data: unknown, mode = 0o644): void {
  mkdirSync(dir(), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode })
  renameSync(tmp, path)
}

const seal = (plain: string): string => safeStorage.encryptString(plain).toString('base64')
const unseal = (sealed: string): string => safeStorage.decryptString(Buffer.from(sealed, 'base64'))

export function listTunnels(): Tunnel[] {
  return readJson<Tunnel[]>(tunnelsPath(), [])
}

export function saveTunnel({ tunnel, secrets }: ParsedTunnel): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(`Системное хранилище ключей (${process.platform === 'darwin' ? 'Keychain' : 'DPAPI'}) недоступно — ключи негде безопасно сохранить`)
  }
  const all = readJson<SecretsFile>(secretsPath(), {})
  all[tunnel.id] = {
    privateKey: seal(secrets.privateKey),
    presharedKey: secrets.presharedKey ? seal(secrets.presharedKey) : undefined
  }
  writeJson(secretsPath(), all, 0o600)
  writeJson(tunnelsPath(), [...listTunnels(), tunnel])
}

export function removeTunnel(id: string): void {
  writeJson(tunnelsPath(), listTunnels().filter((t) => t.id !== id))
  if (existsSync(secretsPath())) {
    const all = readJson<SecretsFile>(secretsPath(), {})
    delete all[id]
    writeJson(secretsPath(), all, 0o600)
  }
}

/** «Нет, стереть» on removal: every server and its keys, gone from this computer. */
export function forgetTunnels(): void {
  for (const path of [tunnelsPath(), secretsPath()]) {
    rmSync(path, { force: true })
    rmSync(`${path}.tmp`, { force: true })
  }
}

export function loadSecrets(id: string): TunnelSecrets | null {
  const entry = readJson<SecretsFile>(secretsPath(), {})[id]
  if (!entry) return null
  return {
    privateKey: unseal(entry.privateKey),
    presharedKey: entry.presharedKey ? unseal(entry.presharedKey) : undefined
  }
}
