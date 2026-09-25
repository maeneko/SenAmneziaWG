import { readFileSync } from 'node:fs'
import { arch, release } from 'node:os'

/** PRETTY_NAME from os-release, e.g. «Ubuntu 24.04.1 LTS». */
export function parseOsRelease(text: string): string | null {
  const m = /^PRETTY_NAME=(?:"([^"]*)"|'([^']*)'|(.*))$/m.exec(text)
  return (m?.[1] ?? m?.[2] ?? m?.[3])?.trim() || null
}

function linuxDistro(): string {
  for (const path of ['/etc/os-release', '/usr/lib/os-release']) {
    try {
      const name = parseOsRelease(readFileSync(path, 'utf8'))
      if (name) return name
    } catch {
      // next
    }
  }
  return 'Linux'
}

/** One journal line about the machine: what a bug report needs first and a user rarely says. */
export function describeSystem(platform = process.platform, env = process.env): string {
  if (platform !== 'linux') return `Система: ${platform} ${release()}, ${arch()}`
  const session = [env.XDG_SESSION_TYPE, env.XDG_CURRENT_DESKTOP].filter(Boolean).join(', ')
  return `Система: ${linuxDistro()}, ядро ${release()}, ${arch()}${session ? `, сеанс ${session}` : ''}`
}
