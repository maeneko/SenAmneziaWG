import { createHash } from 'node:crypto'
import { mkdtemp, open, readdir, rm, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { assemble, hashTree, missingFiles, parseManifest, type Missing } from './files'
import { fetchBuffer, fetchHead, HEADERS_MS, HttpStatusError, idleGuard, IDLE_MS, retry, timedFetch, type Resilience } from './retry'
import { updateMessage, verifyUpdate, UPDATE_KEYS } from './signature'
import type { Found, UpdateSource } from './updater'
import { codedMessage } from '../../shared/errorCatalog'
import { AppError } from '../appError'

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
   * `whole` instead: why this copy downloads the whole installer — said in the journal, like every other
   * reason the update in pieces does not work out. Asked at each download: after an install from such a
   * folder failed, it answers `whole` and the next try is the whole installer.
   */
  installed?: () => { dir: string } | { whole: string }
  log?(level: 'info' | 'warn', message: string): void
  /** How patient to be with the server (retry.ts); tests shorten it. */
  resilience?: Resilience
  /** Blobs are fetched this many at a time (3), when together they are no more than `prefetchBytes`. */
  parallel?: number
  prefetchBytes?: number
}

/** The list of a release's files: a few hundred entries, a few hundred kilobytes. */
const MAX_LIST = 16 * 1024 * 1024
/** Downloading the changed files is worth it only while they are well under the installer. */
const DELTA_SHARE = 0.5

const TREE_PREFIX = 'senawg-tree-'

/**
 * The changed files are many and small (twenty blobs, three megabytes), and the server answers each in a second or
 * two: one after another that is most of a minute. A few at a time it is a third of that — more would only
 * crowd a server that already drops connections. Held in memory until the new version is put together, so only
 * while they are few bytes.
 */
const PARALLEL = 3
const PREFETCH_BYTES = 64 * 1024 * 1024

/**
 * Every blob in `blobs`, `parallel` at a time, each tried again when it fails and read whole into memory (no more
 * than it is said to weigh). `done` gets the bytes fetched so far. One that cannot be had after its tries ends it all.
 * `out` may hold blobs already: what came before a pause, not fetched again.
 */
async function prefetch(
  blobs: Missing[],
  fetchOnce: (sha256: string) => Promise<ReadableStream<Uint8Array>>,
  parallel: number,
  resilience: Resilience,
  done: (bytes: number) => void,
  out = new Map<string, Buffer>()
): Promise<Map<string, Buffer>> {
  const todo = blobs.filter((b) => !out.has(b.sha256))
  let bytes = blobs.reduce((n, b) => n + (out.get(b.sha256)?.length ?? 0), 0)
  if (bytes) done(bytes)
  let next = 0
  let failure: unknown
  const worker = async (): Promise<void> => {
    while (failure === undefined) {
      const blob = todo[next++]
      if (!blob) return
      try {
        const body = await retry(async () => {
          const reader = (await fetchOnce(blob.sha256)).getReader()
          const parts: Buffer[] = []
          let size = 0
          for (;;) {
            const { done: end, value } = await reader.read()
            if (end) break
            size += value.length
            if (size > blob.packed) {
              void reader.cancel().catch(() => undefined)
              throw new Error(`${blob.path}: скачано больше, чем заявлено`)
            }
            parts.push(Buffer.from(value))
          }
          return Buffer.concat(parts)
        }, resilience)
        out.set(blob.sha256, body)
        done((bytes += body.length))
      } catch (err) {
        failure ??= err
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, todo.length)) }, worker))
  if (failure !== undefined) throw failure
  return out
}

/** Where a 206 answer starts: «bytes 1000-9999/10000» → 1000; -1 when it does not say. */
function rangeStart(res: Response): number {
  const m = /^bytes (\d+)-/.exec(res.headers.get('content-range') ?? '')
  return m ? Number(m[1]) : -1
}

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
  // The changed files fetched for a version before its download was paused: going on, they are not fetched again.
  let held: { version: string; blobs: Map<string, Buffer> } | null = null

  // Every request to the server is made again when it fails, and said so in the journal: the server drops or
  // stalls a few requests in a hundred, and an update in pieces is twenty of them.
  const resilience = (what: string): Resilience => ({
    headersMs: HEADERS_MS,
    idleMs: IDLE_MS,
    ...deps.resilience,
    onRetry: (err, next, all) => deps.log?.('info', `Обновление: ${what} — ${err instanceof Error ? err.message : String(err)}; повтор ${next} из ${all}`)
  })
  const get = (url: string | URL, what: string, init: RequestInit = { cache: 'no-store' }): Promise<Buffer> => fetchBuffer(deps.fetch, url, init, resilience(what))

  async function fetchSignature(url: string): Promise<string> {
    let body: Buffer
    try {
      body = await get(url, 'подпись')
    } catch (err) {
      throw err instanceof HttpStatusError ? new AppError('UPD-13', undefined, `HTTP ${err.status}`) : err
    }
    if (body.length > MAX_SIG) throw new AppError('UPD-14', undefined, `${body.length} байт`)
    return body.toString('utf8')
  }

  /**
   * The new version as a folder, built from the installed one and the files that changed — or a reason
   * why not, and the installer is downloaded instead. The list is signed like the installer, and the
   * folder is checked against it file by file (files.ts: assemble).
   */
  async function downloadDelta(
    pick: NonNullable<typeof offered>,
    found: Found,
    installed: string,
    report: (received: number, total?: number) => void,
    signal?: AbortSignal
  ): Promise<string> {
    const listUrl = `${pick.url}.files.json`
    let list: Buffer
    try {
      list = await get(listUrl, 'список файлов')
    } catch (err) {
      if (err instanceof HttpStatusError) throw new Error(err.status === 404 ? 'у этой версии нет списка файлов' : `список файлов недоступен: ${err.status}`)
      throw err
    }
    if (list.length > MAX_LIST) throw new Error('список файлов слишком велик')
    const sig = await fetchSignature(`${listUrl}.sig`)
    const sha = createHash('sha256').update(list).digest('hex')
    if (!verifyUpdate(updateMessage(os, `${pick.name}.files.json`, list.length, sha), sig, deps.keys ?? UPDATE_KEYS)) {
      throw new Error('подпись списка файлов не сошлась')
    }
    const manifest = parseManifest(list.toString('utf8'))
    if (manifest.os !== os || manifest.version !== pick.named) throw new Error('список файлов от другой версии')

    const have = await hashTree(installed, manifest.chunk)
    signal?.throwIfAborted()
    const { blobs, packed } = missingFiles(manifest, have)
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
      const blobUrl = (blob: string): URL => {
        const url = new URL(`${manifest.blobs}${blob.slice(0, 2)}/${blob}.br`, listUrl)
        if (url.origin !== origin) throw new Error(`файл обновления ведёт на чужой адрес: ${url.origin}`)
        return url
      }
      // One try at a blob: where it is retried (prefetch, or assemble when the blobs are too many to hold) is up to the caller.
      const fetchBlobOnce = async (blob: string): Promise<ReadableStream<Uint8Array>> => {
        const r = await timedFetch(deps.fetch, deps.resilience?.headersMs ?? HEADERS_MS)(blobUrl(blob), { cache: 'no-store', signal })
        if (!r.ok) throw new HttpStatusError(r.status, `файл обновления недоступен: ${r.status}`)
        if (!r.body) throw new Error('файл обновления пришёл пустым')
        return idleGuard(r.body, deps.resilience?.idleMs ?? IDLE_MS)
      }
      const onRetry = (err: unknown, next: number, all: number): void =>
        deps.log?.('info', `Обновление: файл обновления — ${err instanceof Error ? err.message : String(err)}; повтор ${next} из ${all}`)
      // The few bytes there are are fetched ahead, a few at a time, and progress is theirs; assemble then reads memory.
      // Those of a paused download are kept for when it goes on.
      if (held?.version !== found.version) held = { version: found.version, blobs: new Map() }
      const prefetched =
        packed <= (deps.prefetchBytes ?? PREFETCH_BYTES)
          ? await prefetch(blobs, fetchBlobOnce, deps.parallel ?? PARALLEL, { ...deps.resilience, onRetry, signal }, (done) => report(done, packed), held.blobs)
          : null
      await assemble(
        manifest,
        have,
        into,
        async (blob) => {
          // From memory once; if that copy turns out wrong, assemble's second try goes to the server.
          const held = prefetched?.get(blob)
          if (!held) return fetchBlobOnce(blob)
          prefetched?.delete(blob)
          return Readable.toWeb(Readable.from(held)) as ReadableStream<Uint8Array>
        },
        (received) => {
          if (!prefetched) report(received, packed)
        },
        {
          ...deps.resilience,
          onRetry,
          signal
        }
      )
    } catch (err) {
      await rm(into, { recursive: true, force: true })
      if (!signal?.aborted) held = null
      throw err
    }
    held = null
    deps.log?.('info', `Обновление ${found.version}: скачано ${mb(packed)} изменившихся файлов вместо ${mb(found.total)}`)
    return into
  }

  return {
    async check() {
      let body: Latest
      try {
        body = JSON.parse((await get(`${origin}/api/page/downloads/${os}`, 'проверка версии')).toString('utf8')) as Latest
      } catch (err) {
        if (err instanceof HttpStatusError) throw new AppError('UPD-02', undefined, `HTTP ${err.status}`)
        if (err instanceof SyntaxError) throw new AppError('UPD-03', undefined, err.message)
        throw err
      }
      if (!body.success || !body.version || !body.url) throw new AppError('UPD-04')
      if (!isNewer(body.version, deps.current)) return null

      let url: URL
      try {
        url = new URL(body.url, origin)
      } catch {
        throw new AppError('UPD-05', undefined, body.url)
      }
      // Same site, over HTTPS, and our own installer — nothing else is downloaded, let alone started.
      if (url.origin !== new URL(origin).origin) throw new AppError('UPD-06', undefined, url.origin)
      const name = decodeURIComponent(url.pathname.split('/').pop() ?? '')
      const named = artifact.ours.exec(name)
      if (!named) throw new AppError('UPD-07', undefined, name)
      // The signature covers the name, so the version in it is the one that counts: an older installer,
      // signed in its day, must not come back as an update under a newer number.
      if (!isNewer(named[1], deps.current)) throw new AppError('UPD-08', undefined, `${name} под видом версии ${body.version}`)

      let head: Response
      try {
        head = await fetchHead(deps.fetch, url, { method: 'HEAD', cache: 'no-store' }, resilience('размер установщика'))
      } catch (err) {
        throw err instanceof HttpStatusError ? new AppError('UPD-09', { version: body.version }, `HTTP ${err.status}`) : err
      }
      const total = Number(head.headers.get('content-length')) || 0
      offered = { version: body.version, url: url.href, name, named: named[1] }
      return { version: body.version, notes: [], total }
    },

    async download(found: Found, report, signal) {
      const pick = offered
      if (pick?.version !== found.version) throw new AppError('UPD-10')
      const file = join(deps.dir, artifact.name(found.version))
      // What a pause left of this very installer is gone on from; one that is all there is not a part of it.
      const kept = (await stat(file).catch(() => null))?.size ?? 0
      const partial = kept > 0 && (!found.total || kept < found.total)
      const installed = deps.installed?.() ?? { whole: 'эта копия не обновляется по частям' }
      const whole = (why: string): void => deps.log?.('info', `Обновление ${found.version} скачивается целиком: ${why}`)
      if (partial) whole(`загрузка продолжается с ${mb(kept)}`)
      else if ('dir' in installed) {
        try {
          const tree = await downloadDelta(pick, found, installed.dir, report, signal)
          return { kind: 'ready', version: found.version, notes: found.notes, file: tree }
        } catch (err) {
          // Paused, not failed: going on, it tries the changed files again.
          if (signal?.aborted) throw err
          whole(err instanceof Error ? err.message : String(err))
          report(0, found.total)
        }
      } else whole(installed.whole)
      const out = await open(file, partial ? 'r+' : 'w')
      let received = 0
      let hash = createHash('sha256')
      let head = Buffer.alloc(0)
      let tail = Buffer.alloc(0)
      let expected = found.total
      const take = (value: Uint8Array): void => {
        if (head.length < 2) head = Buffer.concat([head, value.subarray(0, 2)])
        tail = Buffer.concat([tail, value.subarray(-TAIL)]).subarray(-TAIL)
        hash.update(value)
      }
      // Until the last byte is in, a pause keeps the file to go on from; after it, the file is checked and kept only if it is ours.
      let fetching = true
      const timed = timedFetch(deps.fetch, deps.resilience?.headersMs ?? HEADERS_MS)
      try {
        if (partial) {
          // The signature is over the whole file: the part that is here is counted again.
          const buf = Buffer.alloc(1024 * 1024)
          for (;;) {
            const { bytesRead } = await out.read(buf, 0, buf.length, received)
            if (!bytesRead) break
            take(buf.subarray(0, bytesRead))
            received += bytesRead
          }
          report(received)
        }
        // A connection that drops or stalls halfway costs the rest of the installer, not all of it: the next try
        // asks for the bytes from where this one stopped (the site's nginx answers ranges). A server that ignores
        // the range sends the whole file again, and the download starts over.
        await retry(async () => {
          const res = await timed(pick.url, { cache: 'no-store', headers: received > 0 ? { Range: `bytes=${received}-` } : undefined, signal })
          if (received > 0 && res.status === 200) {
            received = 0
            hash = createHash('sha256')
            head = Buffer.alloc(0)
            tail = Buffer.alloc(0)
            await out.truncate(0)
          } else if (received > 0 && (res.status !== 206 || rangeStart(res) !== received)) {
            throw new HttpStatusError(res.status, codedMessage('UPD-09', { version: found.version }))
          } else if (!res.ok) {
            throw new HttpStatusError(res.status, codedMessage('UPD-09', { version: found.version }))
          }
          if (!res.body) throw new AppError('UPD-11', undefined, 'пустой ответ')
          if (received === 0) expected = Number(res.headers.get('content-length')) || found.total
          const reader = idleGuard(res.body, deps.resilience?.idleMs ?? IDLE_MS).getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            take(value)
            await out.write(value, 0, value.length, received)
            received += value.length
            report(received)
          }
          if (expected && received !== expected) throw new AppError('UPD-11', undefined, `${received} из ${expected} байт`)
        }, {
          ...deps.resilience,
          signal,
          onRetry: (err, next, all) =>
            deps.log?.('info', `Обновление: установщик — ${err instanceof Error ? err.message : String(err)}; повтор ${next} из ${all}${received ? `, докачка с ${mb(received)}` : ''}`)
        })
        fetching = false
        await out.close()
        if (!artifact.looksRight(head, tail)) throw new AppError('UPD-12')
        // Last, and nothing is started before it: the file is ours only if our key signed exactly it.
        const sig = await fetchSignature(`${pick.url}.sig`)
        if (!verifyUpdate(updateMessage(os, pick.name, received, hash.digest('hex')), sig, deps.keys ?? UPDATE_KEYS)) {
          throw new AppError('UPD-15')
        }
      } catch (err) {
        await out.close().catch(() => undefined)
        if (!(fetching && signal?.aborted)) await rm(file, { force: true })
        throw err
      }
      return { kind: 'ready', version: found.version, notes: found.notes, file }
    }
  }
}
