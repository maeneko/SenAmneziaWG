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

/**
 * What the installer for a given `os` string looks like: only our own is ever started, whatever else
 * the site offers for that OS is not an update of this. `os` is `windows` or `linux-x64`/`linux-arm64`
 * (linuxOsName in ../../shared, kept in server.ts's own deps.os so the caller decides the arch once).
 */
interface Artifact {
  /** The `os` the site's API takes: it knows `linux`, not the architecture. */
  apiOs: string
  name(version: string): string
  ours: RegExp
  /**
   * What the site may offer instead of `ours`: on Linux it names one build (x64) for every architecture,
   * and ours is fetched from the same release folder by its own name.
   */
  offered?: RegExp
  /** The file's first bytes, checked against what its own kind actually looks like. */
  looksRight(head: Buffer): boolean
}

const WINDOWS_ARTIFACT: Artifact = {
  apiOs: 'windows',
  name: (version) => `SenAWG-${version}-setup.exe`,
  ours: /^SenAWG-[\w.-]+-setup\.exe$/i,
  looksRight: (head) => head.toString('latin1', 0, 2) === 'MZ'
}

const LINUX_ARTIFACT = (arch: string): Artifact => ({
  apiOs: 'linux',
  offered: /^SenAWG-[\w.-]+-linux-(x64|arm64)\.run$/i,
  name: (version) => `SenAWG-${version}-linux-${arch}.run`,
  ours: new RegExp(`^SenAWG-[\\w.-]+-linux-${arch}\\.run$`, 'i'),
  // scripts/make-run.sh's stub is a POSIX shell script.
  looksRight: (head) => head.toString('latin1', 0, 2) === '#!'
})

function artifactFor(os: string): Artifact {
  const linux = /^linux-(x64|arm64)$/.exec(os)
  return linux ? LINUX_ARTIFACT(linux[1]) : WINDOWS_ARTIFACT
}

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
  const artifact = artifactFor(os)
  // The installer the last check found; the updater hands back only version, notes and size.
  let offered: { version: string; url: string } | null = null

  return {
    async check() {
      const res = await deps.fetch(`${origin}/api/page/downloads/${artifact.apiOs}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`Сервер обновлений ответил ${res.status}`)
      const body = (await res.json()) as Latest
      if (!body.success || !body.version || !body.url) throw new Error('Сервер обновлений ответил без версии')
      if (!isNewer(body.version, deps.current)) return null

      let url = new URL(body.url, origin)
      // Same site, over HTTPS, and our own installer — nothing else is downloaded, let alone started.
      if (url.origin !== new URL(origin).origin) throw new Error(`Обновление ведёт на чужой адрес: ${url.origin}`)
      const name = decodeURIComponent(url.pathname.split('/').pop() ?? '')
      if (artifact.offered?.test(name)) url = new URL(artifact.name(body.version), url)
      else if (!artifact.ours.test(name)) throw new Error(`Сервер предлагает не установщик SenAWG: ${name}`)

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

      const file = join(deps.dir, artifact.name(found.version))
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
        if (!artifact.looksRight(head)) throw new Error('Скачанный файл повреждён или подменён')
      } catch (err) {
        out.destroy()
        await rm(file, { force: true })
        throw err
      }
      return { kind: 'ready', version: found.version, notes: found.notes, file }
    }
  }
}
