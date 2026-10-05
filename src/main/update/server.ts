import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { assemble, hashTree, missingFiles, parseManifest } from './files'
import { updateMessage, verifyUpdate, UPDATE_KEYS } from './signature'
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
 * What the installer for a given `os` looks like: only our own is ever started, whatever else the site
 * offers for that OS is not an update of this. `os` is what the site's API takes — `windows`, `linux` or
 * `macos`; Linux is built for x64 only, macOS for Apple Silicon only.
 */
interface Artifact {
  name(version: string): string
  /** Our own installer's name, the version in its first group. */
  ours: RegExp
  /** The file's first and last bytes, checked against what its own kind actually looks like. */
  looksRight(head: Buffer, tail: Buffer): boolean
}

/** How much of the file's end is kept for looksRight: a disk image's trailer is its last 512 bytes. */
const TAIL = 512

const WINDOWS_ARTIFACT: Artifact = {
  name: (version) => `SenAWG-${version}-setup.exe`,
  ours: /^SenAWG-([\w.-]+)-setup\.exe$/i,
  looksRight: (head) => head.toString('latin1', 0, 2) === 'MZ'
}

const LINUX_ARTIFACT: Artifact = {
  name: (version) => `SenAWG-${version}-linux-x64.run`,
  ours: /^SenAWG-([\w.-]+)-linux-x64\.run$/i,
  // scripts/make-run.sh's stub is a POSIX shell script.
  looksRight: (head) => head.toString('latin1', 0, 2) === '#!'
}

const MAC_ARTIFACT: Artifact = {
  name: (version) => `SenAWG-${version}-arm64.dmg`,
  ours: /^SenAWG-([\w.-]+)-arm64\.dmg$/i,
  // A disk image (UDIF) is marked at its end, not its start: the trailer begins with «koly».
  looksRight: (_head, tail) => tail.length === TAIL && tail.toString('latin1', 0, 4) === 'koly'
}

const artifactFor = (os: UpdateOs): Artifact => (os === 'linux' ? LINUX_ARTIFACT : os === 'macos' ? MAC_ARTIFACT : WINDOWS_ARTIFACT)

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

/** The site's `os` query parameter, for the systems this application updates on. */
export type UpdateOs = 'windows' | 'linux' | 'macos'

export interface ServerDeps {
  /** Electron's net.fetch in the app, so the system proxy applies. */
  fetch: typeof fetch
  /** app.getVersion(). */
  current: string
  /** Where the installer is saved: a temporary folder. */
  dir: string
  /** The site's `os`; `windows` by default. */
  os?: UpdateOs
  origin?: string
  /** Who may sign an update; signature.ts's UPDATE_KEYS unless a test brings its own. */
  keys?: readonly string[]
  /**
   * The installed version's own files (the bundle on macOS, the application's folder on Linux): with it, a
   * release that lists its files (files.ts) is put together from these and only what changed is downloaded.
   * Absent or null, or whenever that does not work out, the whole installer is. Asked at each download:
   * after an install from such a folder failed, it answers null and the next try is the whole installer.
   */
  installed?: () => string | null
  log?(level: 'info' | 'warn', message: string): void
}

/** The list of a release's files: a few hundred entries, a few hundred kilobytes. */
const MAX_LIST = 16 * 1024 * 1024
/** Downloading the changed files is worth it only while they are well under the installer. */
const DELTA_SHARE = 0.5

const TREE_PREFIX = 'senawg-tree-'

const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} МБ`

/** A .sig is one line of base64; anything much longer is not one. */
const MAX_SIG = 1024

/**
 * The site's downloads API: the latest version for the OS, and the installer next to it. The answer has
 * neither notes nor size, so notes stay empty and the size comes from the file's own Content-Length.
 */
export function serverSource(deps: ServerDeps): UpdateSource {
  const origin = deps.origin ?? UPDATE_ORIGIN
  const os = deps.os ?? 'windows'
  const artifact = artifactFor(os)
  // The installer the last check found; the updater hands back only version, notes and size.
  let offered: { version: string; url: string; name: string; named: string } | null = null

  async function fetchSignature(url: string): Promise<string> {
    const res = await deps.fetch(url, { cache: 'no-store' })
    if (!res.ok) throw new Error(`У обновления нет подписи: ${res.status}`)
    const text = await res.text()
    if (text.length > MAX_SIG) throw new Error('Подпись обновления повреждена')
    return text
  }

  /**
   * The new version as a folder, built from the installed one and the files that changed — or a reason
   * why not, and the installer is downloaded instead. The list is signed like the installer, and the
   * folder is checked against it file by file (files.ts: assemble).
   */
  async function downloadDelta(pick: NonNullable<typeof offered>, found: Found, installed: string, report: (received: number, total?: number) => void): Promise<string> {
    const listUrl = `${pick.url}.files.json`
    const res = await deps.fetch(listUrl, { cache: 'no-store' })
    if (!res.ok) throw new Error(res.status === 404 ? 'у этой версии нет списка файлов' : `список файлов недоступен: ${res.status}`)
    const list = Buffer.from(await res.arrayBuffer())
    if (list.length > MAX_LIST) throw new Error('список файлов слишком велик')
    const sig = await fetchSignature(`${listUrl}.sig`)
    const sha = createHash('sha256').update(list).digest('hex')
    if (!verifyUpdate(updateMessage(os, `${pick.name}.files.json`, list.length, sha), sig, deps.keys ?? UPDATE_KEYS)) {
      throw new Error('подпись списка файлов не сошлась')
    }
    const manifest = parseManifest(list.toString('utf8'))
    if (manifest.os !== os || manifest.version !== pick.named) throw new Error('список файлов от другой версии')

    const have = await hashTree(installed, manifest.chunk)
    const { packed } = missingFiles(manifest, have)
    const whole = found.total || manifest.entries.reduce((n, e) => n + (e.type === 'file' ? e.packed : 0), 0)
    if (packed > whole * DELTA_SHARE) throw new Error(`изменилась большая часть файлов (${mb(packed)})`)

    const origin = new URL(pick.url).origin
    // A version is a few hundred megabytes: one put together earlier and never installed (the application
    // restarted in between) goes, rather than piling up in the temporary folder.
    for (const name of await readdir(deps.dir).catch(() => [])) {
      if (name.startsWith(TREE_PREFIX)) await rm(join(deps.dir, name), { recursive: true, force: true }).catch(() => undefined)
    }
    const into = await mkdtemp(join(deps.dir, TREE_PREFIX))
    try {
      report(0, packed)
      await assemble(
        manifest,
        have,
        into,
        async (blob) => {
          const url = new URL(`${manifest.blobs}${blob.slice(0, 2)}/${blob}.br`, listUrl)
          if (url.origin !== origin) throw new Error(`файл обновления ведёт на чужой адрес: ${url.origin}`)
          const r = await deps.fetch(url, { cache: 'no-store' })
          if (!r.ok || !r.body) throw new Error(`файл обновления недоступен: ${r.status}`)
          return r.body
        },
        (received) => report(received, packed)
      )
    } catch (err) {
      await rm(into, { recursive: true, force: true })
      throw err
    }
    deps.log?.('info', `Обновление ${found.version}: скачано ${mb(packed)} изменившихся файлов вместо ${mb(found.total)}`)
    return into
  }

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
      const named = artifact.ours.exec(name)
      if (!named) throw new Error(`Сервер предлагает не установщик SenAWG: ${name}`)
      // The signature covers the name, so the version in it is the one that counts: an older installer,
      // signed in its day, must not come back as an update under a newer number.
      if (!isNewer(named[1], deps.current)) throw new Error(`Сервер предлагает ${name} под видом версии ${body.version}`)

      const head = await deps.fetch(url, { method: 'HEAD', cache: 'no-store' })
      if (!head.ok) throw new Error(`Установщик ${body.version} недоступен: ${head.status}`)
      const total = Number(head.headers.get('content-length')) || 0
      offered = { version: body.version, url: url.href, name, named: named[1] }
      return { version: body.version, notes: [], total }
    },

    async download(found: Found, report) {
      const pick = offered
      if (pick?.version !== found.version) throw new Error('Обновление больше не предлагается')
      const installed = deps.installed?.()
      if (installed) {
        try {
          const tree = await downloadDelta(pick, found, installed, report)
          return { kind: 'ready', version: found.version, notes: found.notes, file: tree }
        } catch (err) {
          deps.log?.('info', `Обновление ${found.version} скачивается целиком: ${err instanceof Error ? err.message : String(err)}`)
          report(0, found.total)
        }
      }
      const res = await deps.fetch(pick.url, { cache: 'no-store' })
      if (!res.ok || !res.body) throw new Error(`Установщик не скачался: ${res.status}`)
      const expected = Number(res.headers.get('content-length')) || found.total

      const file = join(deps.dir, artifact.name(found.version))
      const out = createWriteStream(file)
      let received = 0
      const hash = createHash('sha256')
      let head = Buffer.alloc(0)
      let tail = Buffer.alloc(0)
      try {
        const reader = res.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (head.length < 2) head = Buffer.concat([head, value.subarray(0, 2)])
          tail = Buffer.concat([tail, value.subarray(-TAIL)]).subarray(-TAIL)
          received += value.length
          hash.update(value)
          if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
          report(received)
        }
        await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
        if (expected && received !== expected) throw new Error(`Установщик скачался не целиком: ${received} из ${expected} байт`)
        if (!artifact.looksRight(head, tail)) throw new Error('Скачанный файл повреждён или подменён')
        // Last, and nothing is started before it: the file is ours only if our key signed exactly it.
        const sig = await fetchSignature(`${pick.url}.sig`)
        if (!verifyUpdate(updateMessage(os, pick.name, received, hash.digest('hex')), sig, deps.keys ?? UPDATE_KEYS)) {
          throw new Error('Подпись обновления не сошлась — файл не от SenAWG, он удалён')
        }
      } catch (err) {
        out.destroy()
        await rm(file, { force: true })
        throw err
      }
      return { kind: 'ready', version: found.version, notes: found.notes, file }
    }
  }
}
