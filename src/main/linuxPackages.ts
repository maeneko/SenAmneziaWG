import { accessSync, constants, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * Linux: which package a missing program comes in, and the command that installs it — so an error says
 * «Установите пакет polkit: sudo pacman -S --needed polkit», not just what is missing. The .run's own
 * check, for what the application needs before it can even start, is scripts/run-deps.sh; the families
 * and the way they are told apart are the same there.
 */
export type DistroFamily = 'arch' | 'artix' | 'debian' | 'fedora' | 'suse'

/** What the application runs from the system: pkexec to get the root's rights, zstd to unpack an update. */
export type SystemTool = 'pkexec' | 'zstd'

const PACKAGES: Record<SystemTool, Record<DistroFamily, string>> = {
  pkexec: { arch: 'polkit', artix: 'polkit', debian: 'pkexec', fedora: 'polkit', suse: 'polkit' },
  zstd: { arch: 'zstd', artix: 'zstd', debian: 'zstd', fedora: 'zstd', suse: 'zstd' }
}

/** The name to say where the distribution is not one of the known: the upstream project's. */
const UPSTREAM: Record<SystemTool, string> = { pkexec: 'polkit', zstd: 'zstd' }

const INSTALL: Record<DistroFamily, string> = {
  arch: 'sudo pacman -S --needed',
  artix: 'sudo pacman -S --needed',
  debian: 'sudo apt install',
  fedora: 'sudo dnf install',
  suse: 'sudo zypper install'
}

const field = (text: string, name: string): string => {
  const m = new RegExp(`^${name}=(?:"([^"]*)"|'([^']*)'|(.*))$`, 'm').exec(text)
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim().toLowerCase()
}

/** From os-release: the distribution itself (ID), then what it says it is like (ID_LIKE). */
export function distroFamily(osRelease: string): DistroFamily | null {
  const ids = [field(osRelease, 'ID'), ...field(osRelease, 'ID_LIKE').split(/\s+/)].filter(Boolean)
  // Artix before Arch: it says it is like Arch, and a package or two is named differently.
  if (ids[0] === 'artix') return 'artix'
  for (const id of ids) {
    if (id === 'arch' || id === 'archlinux') return 'arch'
    if (id === 'debian' || id === 'ubuntu') return 'debian'
    if (id === 'fedora' || id === 'rhel' || id === 'centos') return 'fedora'
    if (id === 'suse' || id.startsWith('opensuse')) return 'suse'
  }
  return null
}

function readOsRelease(): string {
  for (const path of ['/etc/os-release', '/usr/lib/os-release']) {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      // next
    }
  }
  return ''
}

/** «polkit: sudo pacman -S --needed polkit», or just «polkit» where the distribution is not known. */
export function packageHint(tool: SystemTool, osRelease = readOsRelease()): string {
  const family = distroFamily(osRelease)
  if (!family) return UPSTREAM[tool]
  const name = PACKAGES[tool][family]
  return `${name}: ${INSTALL[family]} ${name}`
}

/** Whether a program is on PATH — and in the sbin directories, which a user's PATH may leave out. */
export function hasCommand(name: string, path = process.env.PATH ?? ''): boolean {
  const dirs = [...path.split(delimiter), '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  return dirs.some((dir) => {
    if (!dir) return false
    try {
      accessSync(join(dir, name), constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}
