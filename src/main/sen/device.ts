import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import { promisify } from 'node:util'
import { readData, writeData } from '../store'

const run = promisify(execFile)

async function machineId(): Promise<string | null> {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])
      return /"IOPlatformUUID" = "([^"]+)"/.exec(stdout)?.[1] ?? null
    }
    if (process.platform === 'win32') {
      const { stdout } = await run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'])
      return /MachineGuid\s+REG_SZ\s+(\S+)/.exec(stdout)?.[1] ?? null
    }
    for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try {
        const id = readFileSync(file, 'utf8').trim()
        if (id) return id
      } catch {
        /* try the next one */
      }
    }
  } catch {
    /* falls back to a stored random id */
  }
  return null
}

/**
 * The id under which this computer registers with a master key. It has to survive a reinstall: the server
 * takes a repeated id for the same device and swaps it in, instead of spending another slot of the limit.
 * Hashed with the key's own `signPub`, so the id means nothing outside that one server.
 */
export async function deviceIdFor(signPub: Buffer): Promise<string> {
  let base = await machineId()
  if (!base) {
    const saved = readData<{ id?: string }>('device.json', {})
    base = saved.id ?? randomUUID()
    if (!saved.id) writeData('device.json', { id: base })
  }
  return createHash('sha256').update(`senawg:${base}:${signPub.toString('hex')}`).digest('hex').slice(0, 32)
}

/**
 * What the person is called on this computer, as the system says: the full name where it keeps one
 * (macOS, the GECOS field on Linux), the account name otherwise. Empty when it cannot be told.
 */
async function systemUserName(): Promise<string> {
  try {
    if (process.platform === 'darwin') return (await run('/usr/bin/id', ['-F'])).stdout.trim()
    if (process.platform === 'linux') {
      const entry = (await run('getent', ['passwd', userInfo().username])).stdout.trim().split(':')
      return entry[4]?.split(',')[0]?.trim() || userInfo().username
    }
    return userInfo().username
  } catch {
    try {
      return userInfo().username
    } catch {
      return ''
    }
  }
}

/**
 * The name of this device in the list of the key's devices and in the panel: the person's first name only —
 * the operator reads it, and over plain HTTP so does anyone on the way — or the computer's name when the
 * system does not say who the person is.
 */
export function nameFromUser(fullName: string, host: string): string {
  const first = fullName.trim().split(/\s+/)[0] ?? ''
  const clean = first.replace(/[^\p{L}\p{N}'._-]/gu, '').slice(0, 32)
  return clean || host.replace(/\.local$/i, '').slice(0, 64) || 'SenAWG'
}

/** Shown to whoever runs the panel, next to the platform and the app version. */
export async function deviceName(): Promise<string> {
  return nameFromUser(await systemUserName(), hostname())
}
