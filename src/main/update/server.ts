import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Found, UpdateSource } from './updater'

export const UPDATE_ORIGIN = 'https://amnesia.ma7neko.ru'

/** What GET /api/page/downloads/:os answers. */
interface Latest {
  success: boolean
  os?: string
  version?: string
  /** Relative to the site: /downloads/releases/SenAWG-0.6.0-setup.exe. */
  url?: string
  os_version?: string
}

/** Only our own installer is ever started: whatever else the site offers for the OS is not an update of this. */
const OURS = /^SenAWG-[\w.-]+-setup\.exe$/i

/** «1.2.3» against «1.2.10»; a pre-release (1.2.3-beta) is older than its release. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string): [number[], string] => {
    const [core, pre = ''] = v.trim().replace(/^v/i, '').split('-', 2) as [string, string?]
    return [core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre]
  }
  const [a, aPre] = parse(candidate)
  const [b, bPre] = parse(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d > 0
  }
  if (aPre === bPre) return false
  if (!aPre) return true
  if (!bPre) return false
  return aPre.localeCompare(bPre, 'en', { numeric: true }) > 0
}

export interface ServerDeps {
  /** Electron's net.fetch in the app, so the system proxy applies. */
  fetch: typeof fetch
  /** app.getVersion(). */
  current: string
  /** Where the installer is saved: a temporary folder. */
  dir: string
  os?: string
  origin?: string
}

/**
 * The site's downloads API: the latest version for the OS, and the installer next to it. The answer has
 * neither notes nor size, so notes stay empty and the size comes from the file's own Content-Length.
 */
export function serverSource(deps: ServerDeps): UpdateSource {
  const origin = deps.origin ?? UPDATE_ORIGIN
  const os = deps.os ?? 'windows'
  // The installer the last check found; the updater hands back only version, notes and size.
  let offered: { version: string; url: string } | null = null

  return {
    async check() {
      const res = await deps.fetch(`${origin}/api/page/downloads/${os}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`Сервер обновлений ответил ${res.status}`)
      const body = (await res.json()) as Latest
      if (!body.success || !body.version || !body.url) throw new Error('Сервер обновлений ответил без версии')
      if (!isNewer(body.version, deps.current)) return null

      const url = new URL(body.url, origin)
      // Same site, over HTTPS, and our own installer — nothing else is downloaded, let alone started.
      if (url.origin !== new URL(origin).origin) throw new Error(`Обновление ведёт на чужой адрес: ${url.origin}`)
      const name = decodeURIComponent(url.pathname.split('/').pop() ?? '')
      if (!OURS.test(name)) throw new Error(`Сервер предлагает не установщик SenAWG: ${name}`)

      const head = await deps.fetch(url, { method: 'HEAD', cache: 'no-store' })
      if (!head.ok) throw new Error(`Установщик ${body.version} недоступен: ${head.status}`)
      const total = Number(head.headers.get('content-length')) || 0
      offered = { version: body.version, url: url.href }
      return { version: body.version, notes: [], total }
    },

    async download(found: Found, report) {
      if (offered?.version !== found.version) throw new Error('Обновление больше не предлагается')
      const res = await deps.fetch(offered.url, { cache: 'no-store' })
      if (!res.ok || !res.body) throw new Error(`Установщик не скачался: ${res.status}`)
      const expected = Number(res.headers.get('content-length')) || found.total

      const file = join(deps.dir, `SenAWG-${found.version}-setup.exe`)
      const out = createWriteStream(file)
      let received = 0
      let head = Buffer.alloc(0)
      try {
        const reader = res.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (head.length < 2) head = Buffer.concat([head, value.subarray(0, 2)])
          received += value.length
          if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
          report(received)
        }
        await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
        if (expected && received !== expected) throw new Error(`Установщик скачался не целиком: ${received} из ${expected} байт`)
        if (head.toString('latin1', 0, 2) !== 'MZ') throw new Error('Скачанный файл — не программа Windows')
      } catch (err) {
        out.destroy()
        await rm(file, { force: true })
        throw err
      }
      return { kind: 'ready', version: found.version, notes: found.notes, file }
    }
  }
}
