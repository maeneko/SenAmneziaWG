import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Tunnel } from '../shared/types'
import type { ParsedTunnel, TunnelSecrets } from './config/wgConfig'

/** Sealed with safeStorage, or only a note that the SenAWG service keeps this tunnel's keys. */
type SecretsEntry = { privateKey: string; presharedKey?: string } | { heldByService: true }
type SecretsFile = Record<string, SecretsEntry>

/**
 * Where the keys go when safeStorage has nothing real to seal them with: on Linux, the SenAWG service
 * (helper/internal/vault — root-only files, as NetworkManager and wg-quick keep theirs). Set once at
 * start-up by the backend that has one (linuxBackend.ts); none on macOS and Windows, where safeStorage
 * always has the Keychain or DPAPI.
 */
export interface KeyVault {
  put(id: string, secrets: TunnelSecrets): Promise<void>
  delete(id: string): Promise<void>
}

let vault: KeyVault | null = null

export function useKeyVault(v: KeyVault | null): void {
  vault = v
}

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

/** Small JSON files that live beside tunnels.json (the subscriptions); the secrets never go through here. */
export const readData = <T>(name: string, fallback: T): T => readJson(join(dir(), name), fallback)
export const writeData = (name: string, data: unknown): void => writeJson(join(dir(), name), data)

const seal = (plain: string): string => safeStorage.encryptString(plain).toString('base64')
const unseal = (sealed: string): string => safeStorage.decryptString(Buffer.from(sealed, 'base64'))

export function listTunnels(): Tunnel[] {
  return readJson<Tunnel[]>(tunnelsPath(), [])
}

/** What safeStorage backs onto, for the one error message that names it. */
const keyringName = (): string =>
  process.platform === 'darwin' ? 'Keychain' : process.platform === 'linux' ? 'gnome-keyring или kwallet' : 'DPAPI'

/**
 * Whether safeStorage really encrypts. On Linux with no Secret Service or KWallet it falls back to
 * "basic_text" and still reports itself available, but that is a key built into Chromium, the same on
 * every computer — obfuscation, not encryption.
 */
function keyringUsable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
}

/** Where saveTunnel put the keys, for the journal. */
export type KeyPlace = 'keyring' | 'service'

/**
 * Seals `secrets` under `id` (or hands them to the service) and records where they went. Also holds the
 * subscription auth keys, under `sen-<id>`: an Ed25519 seed is 32 bytes in base64 like a WireGuard key.
 */
export async function saveSecrets(id: string, secrets: TunnelSecrets): Promise<KeyPlace> {
  let entry: SecretsEntry
  let place: KeyPlace
  if (keyringUsable()) {
    entry = {
      privateKey: seal(secrets.privateKey),
      presharedKey: secrets.presharedKey ? seal(secrets.presharedKey) : undefined
    }
    place = 'keyring'
  } else if (vault) {
    await vault.put(id, secrets)
    entry = { heldByService: true }
    place = 'service'
  } else {
    throw new Error(`Системное хранилище ключей (${keyringName()}) недоступно — ключи негде безопасно сохранить`)
  }
  const all = readJson<SecretsFile>(secretsPath(), {})
  all[id] = entry
  writeJson(secretsPath(), all, 0o600)
  return place
}

export async function removeSecrets(id: string): Promise<void> {
  if (!existsSync(secretsPath())) return
  const all = readJson<SecretsFile>(secretsPath(), {})
  const entry = all[id]
  delete all[id]
  writeJson(secretsPath(), all, 0o600)
  if (entry && 'heldByService' in entry) await vault?.delete(id)
}

export async function saveTunnel({ tunnel, secrets }: ParsedTunnel): Promise<KeyPlace> {
  const place = await saveSecrets(tunnel.id, secrets)
  writeJson(tunnelsPath(), [...listTunnels(), tunnel])
  return place
}

/**
 * Replaces a tunnel in place, keeping its id (and so its place in the list and its remembered choice).
 * `secrets` is given when they changed too — a new key after a rekey, a new preshared key.
 */
export async function updateTunnel(tunnel: Tunnel, secrets?: TunnelSecrets): Promise<void> {
  if (!listTunnels().some((t) => t.id === tunnel.id)) throw new Error('Туннель не найден')
  if (secrets) await saveSecrets(tunnel.id, secrets)
  writeJson(tunnelsPath(), listTunnels().map((t) => (t.id === tunnel.id ? tunnel : t)))
}

export async function removeTunnel(id: string): Promise<void> {
  writeJson(tunnelsPath(), listTunnels().filter((t) => t.id !== id))
  await removeSecrets(id)
}

/**
 * «Нет, стереть» on removal: every server and its keys, gone from this computer. Keys the service kept
 * go with `awg-helper remove` itself (uninstall/index.ts passes --keep-secrets only to keep them).
 */
export function forgetTunnels(): void {
  for (const path of [tunnelsPath(), secretsPath(), join(dir(), 'subscriptions.json')]) {
    rmSync(path, { force: true })
    rmSync(`${path}.tmp`, { force: true })
  }
}

export function loadSecrets(id: string): TunnelSecrets | null {
  const entry = readJson<SecretsFile>(secretsPath(), {})[id]
  if (!entry) return null
  if ('heldByService' in entry) return { privateKey: '', heldByService: true }
  return {
    privateKey: unseal(entry.privateKey),
    presharedKey: entry.presharedKey ? unseal(entry.presharedKey) : undefined
  }
}
