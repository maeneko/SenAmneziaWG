import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, copyFile, constants, lstat, mkdir, readdir, readlink, symlink } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createBrotliDecompress } from 'node:zlib'
import type { UpdateOs } from './server'

/**
 * The update in pieces: every file of a release, by its SHA-256, so a newer version is put together from
 * the files this computer already has and only the ones that changed are downloaded. scripts/make-delta.mjs
 * writes the manifest (`<installer>.files.json`, signed like the installer) and the changed files as
 * brotli blobs, `<blobs>/<sha256[0:2]>/<sha256>.br`. The result must be byte for byte the tree inside the
 * full installer — on macOS that is what keeps the bundle's seal intact — so it is checked as a whole
 * before anything runs from it.
 */
export const FILES_FORMAT = 'senawg-files-v1'

export type FileEntry =
  | { path: string; type: 'dir'; mode: number }
  | { path: string; type: 'file'; mode: number; size: number; sha256: string; packed: number }
  | { path: string; type: 'link'; target: string }

export interface FilesManifest {
  os: UpdateOs
  version: string
  /** Where the blobs are, relative to the manifest's own address. */
  blobs: string
  entries: FileEntry[]
}

/** Far above a real release (≈700 entries in the macOS bundle, ≈300 MB), small enough to refuse junk. */
const MAX_ENTRIES = 20_000
const MAX_TOTAL = 4 * 1024 ** 3

export class FilesError extends Error {}

const isInt = (n: unknown, max = Number.MAX_SAFE_INTEGER): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= max

/** A path inside the tree: relative, `/`-separated, already normal, never leaving it. */
function safePath(p: unknown): p is string {
  return (
    typeof p === 'string' &&
    p.length > 0 &&
    p.length <= 1024 &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    !p.includes('\0') &&
    posix.normalize(p) === p &&
    p !== '.' &&
    !p.split('/').includes('..')
  )
}

/** A link points somewhere inside the tree, relative to where it stands. */
function safeLink(path: string, target: unknown): target is string {
  if (typeof target !== 'string' || !target || target.startsWith('/') || target.includes('\0') || target.includes('\\')) return false
  const resolved = posix.normalize(posix.join(posix.dirname(path), target))
  return resolved !== '..' && !resolved.startsWith('../') && !resolved.startsWith('/')
}

/** The manifest as it came off the wire — after its signature, and still not trusted an inch further. */
export function parseManifest(text: string): FilesManifest {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new FilesError('список файлов обновления — не JSON')
  }
  if (raw?.format !== FILES_FORMAT) throw new FilesError('неизвестный формат списка файлов')
  const { os, version, blobs, entries } = raw
  if (os !== 'windows' && os !== 'linux' && os !== 'macos') throw new FilesError('список файлов не для этой системы')
  if (typeof version !== 'string' || !/^[\w.-]{1,64}$/.test(version)) throw new FilesError('в списке файлов нет версии')
  if (typeof blobs !== 'string' || !/^[A-Za-z0-9._/-]{1,256}$/.test(blobs) || !blobs.endsWith('/') || blobs.startsWith('/')) {
    throw new FilesError('в списке файлов неверный адрес')
  }
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_ENTRIES) throw new FilesError('в списке файлов нет файлов')

  const seen = new Set<string>()
  let total = 0
  const out: FileEntry[] = entries.map((e: unknown): FileEntry => {
    const r = (e ?? {}) as Record<string, unknown>
    if (!safePath(r.path) || seen.has(r.path)) throw new FilesError(`недопустимый путь в списке файлов: ${String(r.path)}`)
    seen.add(r.path)
    const path = r.path
    if (r.type === 'dir' && isInt(r.mode, 0o777)) return { path, type: 'dir', mode: r.mode }
    if (r.type === 'link' && safeLink(path, r.target)) return { path, type: 'link', target: r.target }
    if (
      r.type === 'file' &&
      isInt(r.mode, 0o777) &&
      isInt(r.size, MAX_TOTAL) &&
      isInt(r.packed, MAX_TOTAL) &&
      typeof r.sha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(r.sha256)
    ) {
      total += r.size
      return { path, type: 'file', mode: r.mode, size: r.size, sha256: r.sha256, packed: r.packed }
    }
    throw new FilesError(`неверная запись в списке файлов: ${path}`)
  })
  if (total > MAX_TOTAL) throw new FilesError('список файлов обновления слишком велик')
  // Everything sits in a directory the list names: nothing is put where the list did not say.
  const dirs = new Set(out.filter((e) => e.type === 'dir').map((e) => e.path))
  for (const e of out) {
    const parent = posix.dirname(e.path)
    if (parent !== '.' && !dirs.has(parent)) throw new FilesError(`нет каталога для ${e.path}`)
  }
  return { os, version, blobs, entries: out }
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('error', reject)
      .on('data', (c) => hash.update(c))
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/** Every regular file under `root`, by content: what the installed version can give the new one. */
export async function hashTree(root: string): Promise<Map<string, string>> {
  const bySha = new Map<string, string>()
  const walk = async (dir: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const abs = join(dir, name)
      const st = await lstat(abs)
      if (st.isDirectory()) await walk(abs)
      else if (st.isFile()) {
        const sha = await sha256File(abs)
        if (!bySha.has(sha)) bySha.set(sha, abs)
      }
    }
  }
  await walk(root)
  return bySha
}

/** The files the installed version does not have, and how much downloading them takes. */
export function missingFiles(manifest: FilesManifest, have: Map<string, string>): { files: Extract<FileEntry, { type: 'file' }>[]; packed: number } {
  const files: Extract<FileEntry, { type: 'file' }>[] = []
  const wanted = new Set<string>()
  for (const e of manifest.entries) {
    if (e.type !== 'file' || have.has(e.sha256) || wanted.has(e.sha256)) continue
    wanted.add(e.sha256)
    files.push(e)
  }
  return { files, packed: files.reduce((n, f) => n + f.packed, 0) }
}

/** One blob: its compressed bytes, as a web stream (net.fetch's body). */
export type FetchBlob = (sha256: string) => Promise<ReadableStream<Uint8Array>>

/**
 * Builds the new version in `into` (an empty directory): links and directories as listed, each file
 * copied from the installed version when it has the same content, otherwise downloaded and unpacked.
 * `progress` gets the compressed bytes downloaded so far. Then the whole of `into` is checked against the
 * list; anything off throws, and the caller throws `into` away.
 */
export async function assemble(
  manifest: FilesManifest,
  have: Map<string, string>,
  into: string,
  fetchBlob: FetchBlob,
  progress: (received: number) => void = () => {}
): Promise<void> {
  for (const e of manifest.entries) if (e.type === 'dir') await mkdir(join(into, e.path), { recursive: true })

  // Downloaded once per content, then copied like the files the installed version had.
  const got = new Map(have)
  let received = 0
  for (const f of missingFiles(manifest, have).files) {
    const dst = join(into, f.path)
    await download(await fetchBlob(f.sha256), dst, f, (n) => progress((received += n)))
    got.set(f.sha256, dst)
  }
  for (const e of manifest.entries) {
    const dst = join(into, e.path)
    if (e.type === 'link') await symlink(e.target, dst)
    if (e.type !== 'file') continue
    const src = got.get(e.sha256) as string
    if (src !== dst) await copyFile(src, dst, constants.COPYFILE_FICLONE)
    await chmod(dst, e.mode)
  }
  // Last, as a directory without write permission could not have been filled.
  for (const e of [...manifest.entries].reverse()) if (e.type === 'dir') await chmod(join(into, e.path), e.mode)
  await verifyTree(into, manifest)
}

/** Passes chunks on, letting `see` look at each first — and stop the stream by throwing. */
const meter = (see: (chunk: Buffer) => void): Transform =>
  new Transform({
    transform(chunk: Buffer, _enc, done) {
      try {
        see(chunk)
        done(null, chunk)
      } catch (err) {
        done(err as Error)
      }
    }
  })

async function download(body: ReadableStream<Uint8Array>, dst: string, f: Extract<FileEntry, { type: 'file' }>, counted: (n: number) => void): Promise<void> {
  const hash = createHash('sha256')
  let packed = 0
  let size = 0
  await pipeline(
    Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>),
    meter((c) => {
      packed += c.length
      if (packed > f.packed) throw new FilesError(`${f.path}: скачано больше, чем заявлено`)
      counted(c.length)
    }),
    createBrotliDecompress(),
    // A blob that unpacks into more than its file is not that file; stop before the disk fills.
    meter((c) => {
      size += c.length
      if (size > f.size) throw new FilesError(`${f.path}: распаковано больше, чем заявлено`)
      hash.update(c)
    }),
    createWriteStream(dst, { mode: 0o600 })
  )
  if (size !== f.size || hash.digest('hex') !== f.sha256) throw new FilesError(`${f.path}: скачанный файл не совпал со списком`)
}

/** `root` holds exactly what the list names — no more, no less, every file with its content. */
export async function verifyTree(root: string, manifest: FilesManifest): Promise<void> {
  const want = new Map(manifest.entries.map((e) => [e.path, e]))
  const found = new Set<string>()
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      const path = rel ? `${rel}/${name}` : name
      const abs = join(dir, name)
      const e = want.get(path)
      if (!e) throw new FilesError(`лишний файл: ${path}`)
      found.add(path)
      const st = await lstat(abs)
      if (e.type === 'dir') {
        if (!st.isDirectory()) throw new FilesError(`${path}: не каталог`)
        await walk(abs, path)
      } else if (e.type === 'link') {
        if (!st.isSymbolicLink() || (await readlink(abs)) !== e.target) throw new FilesError(`${path}: не та ссылка`)
      } else if (!st.isFile() || st.size !== e.size || (st.mode & 0o777) !== e.mode || (await sha256File(abs)) !== e.sha256) {
        throw new FilesError(`${path}: не совпал со списком`)
      }
    }
  }
  await walk(root, '')
  for (const path of want.keys()) if (!found.has(path)) throw new FilesError(`нет файла: ${path}`)
}
