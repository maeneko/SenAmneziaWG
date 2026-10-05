import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, copyFile, constants, lstat, mkdir, open, readdir, readlink, symlink } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { brotliDecompress, createBrotliDecompress } from 'node:zlib'
import type { UpdateOs } from './server'

/**
 * The update in pieces: every file of a release, by its SHA-256, so a newer version is put together from
 * the files this computer already has and only the ones that changed are downloaded. scripts/make-delta.mjs
 * writes the manifest (`<installer>.files.json`, signed like the installer) and the changed files as
 * brotli blobs, `<blobs>/<sha256[0:2]>/<sha256>.br`. The result must be byte for byte the tree inside the
 * full installer — on macOS that is what keeps the bundle's seal intact — so it is checked as a whole
 * before anything runs from it.
 *
 * A file bigger than one chunk is also listed in chunks (`chunks`, `chunk` bytes each but the last), each
 * a blob of its own: a file that changed in one place — SenAWG.exe, whose version sits in its resources
 * near the end — costs only the chunks around that place. The whole-file blob stays for 0.7.8, which knows
 * no chunks.
 */
export const FILES_FORMAT = 'senawg-files-v1'

/** make-delta.mjs: CHUNK. The manifest says which size it used; this is for one that does not. */
export const DEFAULT_CHUNK = 1024 * 1024

export interface Chunk {
  sha256: string
  size: number
  packed: number
}

export type FileEntry =
  | { path: string; type: 'dir'; mode: number }
  | { path: string; type: 'file'; mode: number; size: number; sha256: string; packed: number; chunks?: Chunk[] }
  | { path: string; type: 'link'; target: string }

type FileItem = Extract<FileEntry, { type: 'file' }>

export interface FilesManifest {
  os: UpdateOs
  version: string
  /** Where the blobs are, relative to the manifest's own address. */
  blobs: string
  /** The size of every chunk but a file's last. */
  chunk: number
  entries: FileEntry[]
}

/** Far above a real release (≈700 entries in the macOS bundle, ≈300 MB), small enough to refuse junk. */
const MAX_ENTRIES = 20_000
const MAX_CHUNKS = 200_000
const MAX_TOTAL = 4 * 1024 ** 3
const MAX_CHUNK = 16 * 1024 * 1024

/** Windows has no POSIX permissions: there they are neither set nor compared. */
const posixModes = process.platform !== 'win32'

export class FilesError extends Error {}

const isInt = (n: unknown, max = Number.MAX_SAFE_INTEGER): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= max
const isSha = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s)

/**
 * A path inside the tree: relative, `/`-separated, already normal, never leaving it — and nothing Windows
 * reads as something else (`a:b` is a stream of the file `a` there).
 */
function safePath(p: unknown): p is string {
  return (
    typeof p === 'string' &&
    p.length > 0 &&
    p.length <= 1024 &&
    !p.startsWith('/') &&
    !/[\\\0:*?"<>|]/.test(p) &&
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

/** A file's chunks, if it lists any: each a whole chunk but the last, together exactly the file. */
function parseChunks(r: Record<string, unknown>, size: number, chunk: number): Chunk[] | undefined {
  if (r.chunks === undefined) return undefined
  if (!Array.isArray(r.chunks) || r.chunks.length === 0) throw new FilesError(`неверные части файла ${String(r.path)}`)
  const chunks = r.chunks.map((c: unknown, i, all): Chunk => {
    const k = (c ?? {}) as Record<string, unknown>
    const last = i === all.length - 1
    if (!isSha(k.sha256) || !isInt(k.size, chunk) || !isInt(k.packed, MAX_TOTAL) || k.size === 0 || (!last && k.size !== chunk)) {
      throw new FilesError(`неверные части файла ${String(r.path)}`)
    }
    return { sha256: k.sha256, size: k.size, packed: k.packed }
  })
  if (chunks.reduce((n, c) => n + c.size, 0) !== size) throw new FilesError(`части файла ${String(r.path)} не складываются в него`)
  return chunks
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
  const chunk = raw.chunk === undefined ? DEFAULT_CHUNK : raw.chunk
  if (!isInt(chunk, MAX_CHUNK) || chunk < 64 * 1024) throw new FilesError('в списке файлов неверный размер части')
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_ENTRIES) throw new FilesError('в списке файлов нет файлов')

  const seen = new Set<string>()
  let total = 0
  let chunkCount = 0
  const out: FileEntry[] = entries.map((e: unknown): FileEntry => {
    const r = (e ?? {}) as Record<string, unknown>
    if (!safePath(r.path) || seen.has(r.path)) throw new FilesError(`недопустимый путь в списке файлов: ${String(r.path)}`)
    seen.add(r.path)
    const path = r.path
    if (r.type === 'dir' && isInt(r.mode, 0o777)) return { path, type: 'dir', mode: r.mode }
    if (r.type === 'link' && safeLink(path, r.target)) return { path, type: 'link', target: r.target }
    if (r.type === 'file' && isInt(r.mode, 0o777) && isInt(r.size, MAX_TOTAL) && isInt(r.packed, MAX_TOTAL) && isSha(r.sha256)) {
      total += r.size
      const chunks = parseChunks(r, r.size, chunk)
      chunkCount += chunks?.length ?? 0
      return { path, type: 'file', mode: r.mode, size: r.size, sha256: r.sha256, packed: r.packed, ...(chunks ? { chunks } : {}) }
    }
    throw new FilesError(`неверная запись в списке файлов: ${path}`)
  })
  if (total > MAX_TOTAL || chunkCount > MAX_CHUNKS) throw new FilesError('список файлов обновления слишком велик')
  // Everything sits in a directory the list names: nothing is put where the list did not say.
  const dirs = new Set(out.filter((e) => e.type === 'dir').map((e) => e.path))
  for (const e of out) {
    const parent = posix.dirname(e.path)
    if (parent !== '.' && !dirs.has(parent)) throw new FilesError(`нет каталога для ${e.path}`)
  }
  return { os, version, blobs, chunk, entries: out }
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

/** Where some content already is: a whole file, or a range of one. */
export interface Place {
  path: string
  offset: number
  size: number
}

/** What the installed version can give the new one: its files by content, and every chunk of them. */
export interface Have {
  files: Map<string, string>
  chunks: Map<string, Place>
}

/**
 * Every regular file under `root`, by content and by `chunk`-sized pieces, in one read of each. What cannot
 * be read (a folder only the service may open) is simply not offered: the new version downloads it instead.
 */
export async function hashTree(root: string, chunk = DEFAULT_CHUNK): Promise<Have> {
  const have: Have = { files: new Map(), chunks: new Map() }
  const buf = Buffer.alloc(chunk)
  const walk = async (dir: string): Promise<void> => {
    for (const name of (await readdir(dir).catch(() => [])).sort()) {
      const abs = join(dir, name)
      const st = await lstat(abs)
      if (st.isDirectory()) await walk(abs)
      else if (st.isFile()) {
        const whole = createHash('sha256')
        const fh = await open(abs, 'r').catch(() => null)
        if (!fh) continue
        // Its chunks are offered only once the whole file has been read: a read that fails halfway offers nothing.
        const found: [string, Place][] = []
        try {
          for (let offset = 0; ; ) {
            // A full chunk, or what is left: read until either, a short read is not the end.
            let got = 0
            for (let n; got < chunk && (n = (await fh.read(buf, got, chunk - got, offset + got)).bytesRead) > 0; ) got += n
            if (got === 0) break
            const piece = buf.subarray(0, got)
            whole.update(piece)
            found.push([createHash('sha256').update(piece).digest('hex'), { path: abs, offset, size: got }])
            offset += got
            if (got < chunk) break
          }
        } catch {
          continue
        } finally {
          await fh.close()
        }
        for (const [sha, place] of found) if (!have.chunks.has(sha)) have.chunks.set(sha, place)
        const sha = whole.digest('hex')
        if (!have.files.has(sha)) have.files.set(sha, abs)
      }
    }
  }
  await walk(root)
  return have
}

/** One blob to download: a whole file, or a chunk of one. */
export interface Missing {
  sha256: string
  size: number
  packed: number
  path: string
}

/** The blobs the installed version does not have, each once, and how much downloading them takes. */
export function missingFiles(manifest: FilesManifest, have: Have): { blobs: Missing[]; packed: number } {
  const blobs: Missing[] = []
  const made = new Set<string>()
  const wanted = new Set<string>()
  const want = (b: Missing): void => {
    if (have.chunks.has(b.sha256) || wanted.has(b.sha256)) return
    wanted.add(b.sha256)
    blobs.push(b)
  }
  for (const e of manifest.entries) {
    if (e.type !== 'file' || have.files.has(e.sha256) || made.has(e.sha256)) continue
    made.add(e.sha256)
    if (e.chunks) for (const c of e.chunks) want({ ...c, path: e.path })
    else if (!wanted.has(e.sha256)) {
      wanted.add(e.sha256)
      blobs.push({ sha256: e.sha256, size: e.size, packed: e.packed, path: e.path })
    }
  }
  return { blobs, packed: blobs.reduce((n, b) => n + b.packed, 0) }
}

/** One blob: its compressed bytes, as a web stream (net.fetch's body). */
export type FetchBlob = (sha256: string) => Promise<ReadableStream<Uint8Array>>

/**
 * Builds the new version in `into` (an empty directory): links and directories as listed, each file
 * copied from the installed version when it has the same content, put together chunk by chunk when it
 * lists chunks (each from the installed version when it has one like it), otherwise downloaded whole.
 * `progress` gets the compressed bytes downloaded so far. Then the whole of `into` is checked against the
 * list; anything off throws, and the caller throws `into` away.
 */
export async function assemble(
  manifest: FilesManifest,
  have: Have,
  into: string,
  fetchBlob: FetchBlob,
  progress: (received: number) => void = () => {}
): Promise<void> {
  for (const e of manifest.entries) if (e.type === 'dir') await mkdir(join(into, e.path), { recursive: true })

  // Grows as files are written, so content downloaded once is copied from there after.
  const files = new Map(have.files)
  const chunks = new Map(have.chunks)
  let received = 0
  const counted = (n: number): void => progress((received += n))

  for (const e of manifest.entries) {
    const dst = join(into, e.path)
    if (e.type === 'link') await symlink(e.target, dst)
    if (e.type !== 'file') continue
    const src = files.get(e.sha256)
    if (src) await copyFile(src, dst, constants.COPYFILE_FICLONE)
    else if (e.chunks) await writeChunks(e, e.chunks, dst, chunks, fetchBlob, counted)
    else await download(await fetchBlob(e.sha256), dst, e, counted)
    files.set(e.sha256, dst)
    if (!e.chunks && e.size <= manifest.chunk && e.size > 0) chunks.set(e.sha256, { path: dst, offset: 0, size: e.size })
    if (posixModes) await chmod(dst, e.mode)
  }
  // Last, as a directory without write permission could not have been filled.
  if (posixModes) for (const e of [...manifest.entries].reverse()) if (e.type === 'dir') await chmod(join(into, e.path), e.mode)
  await verifyTree(into, manifest)
}

const unbrotli = promisify(brotliDecompress)

/** A file put together from its chunks: each read from where it already is, or downloaded, and checked. */
async function writeChunks(
  f: FileItem,
  list: Chunk[],
  dst: string,
  chunks: Map<string, Place>,
  fetchBlob: FetchBlob,
  counted: (n: number) => void
): Promise<void> {
  const out = await open(dst, 'w', 0o600)
  try {
    let offset = 0
    for (const c of list) {
      const at = chunks.get(c.sha256)
      const piece = at ? await readPlace(at) : await fetchChunk(f, c, fetchBlob, counted)
      if (piece.length !== c.size || createHash('sha256').update(piece).digest('hex') !== c.sha256) {
        throw new FilesError(`${f.path}: часть файла не совпала со списком`)
      }
      await out.write(piece, 0, piece.length, offset)
      if (!at) chunks.set(c.sha256, { path: dst, offset, size: c.size })
      offset += c.size
    }
  } finally {
    await out.close()
  }
}

async function readPlace(at: Place): Promise<Buffer> {
  const fh = await open(at.path, 'r')
  try {
    const buf = Buffer.alloc(at.size)
    let got = 0
    for (let n; got < at.size && (n = (await fh.read(buf, got, at.size - got, at.offset + got)).bytesRead) > 0; ) got += n
    return buf.subarray(0, got)
  } finally {
    await fh.close()
  }
}

/** One chunk off the wire: no more than its blob is said to weigh, unpacked to no more than the chunk. */
async function fetchChunk(f: FileItem, c: Chunk, fetchBlob: FetchBlob, counted: (n: number) => void): Promise<Buffer> {
  const parts: Buffer[] = []
  let packed = 0
  for await (const part of Readable.fromWeb((await fetchBlob(c.sha256)) as import('node:stream/web').ReadableStream<Uint8Array>)) {
    packed += (part as Buffer).length
    if (packed > c.packed) throw new FilesError(`${f.path}: скачано больше, чем заявлено`)
    counted((part as Buffer).length)
    parts.push(part as Buffer)
  }
  try {
    return await unbrotli(Buffer.concat(parts), { maxOutputLength: c.size })
  } catch {
    throw new FilesError(`${f.path}: часть файла не распаковалась`)
  }
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

async function download(body: ReadableStream<Uint8Array>, dst: string, f: FileItem, counted: (n: number) => void): Promise<void> {
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
      } else if (!st.isFile() || st.size !== e.size || (posixModes && (st.mode & 0o777) !== e.mode) || (await sha256File(abs)) !== e.sha256) {
        throw new FilesError(`${path}: не совпал со списком`)
      }
    }
  }
  await walk(root, '')
  for (const path of want.keys()) if (!found.has(path)) throw new FilesError(`нет файла: ${path}`)
}
