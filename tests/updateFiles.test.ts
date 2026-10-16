import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { brotliCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assemble, FILES_FORMAT, hashTree, missingFiles, parseManifest, verifyTree, type FilesManifest } from '../src/main/update/files'
import { serverSource } from '../src/main/update/server'
import { updateMessage } from '../src/main/update/signature'
import type { Found } from '../src/main/update/updater'

const MAKE_DELTA = join(__dirname, '..', 'scripts', 'make-delta.mjs')

let work: string
beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'senawg-files-'))
})
afterEach(() => rm(work, { recursive: true, force: true }))

/** A small release: an executable, a resource, the same bytes twice, a link, a nested folder. */
async function release(dir: string, asar: string): Promise<void> {
  await mkdir(join(dir, 'resources', 'deep'), { recursive: true })
  await writeFile(join(dir, 'senawg'), 'ELF the application')
  await chmod(join(dir, 'senawg'), 0o755)
  await writeFile(join(dir, 'resources', 'app.asar'), asar)
  await writeFile(join(dir, 'resources', 'deep', 'a.pak'), 'same bytes')
  await writeFile(join(dir, 'resources', 'deep', 'b.pak'), 'same bytes')
  await symlink('deep/a.pak', join(dir, 'resources', 'current.pak'))
}

/** make-delta.mjs over `tree`, as the build job runs it; the list and the blobs it wrote. */
function makeDelta(tree: string, installer: string, out: string): { list: string; blobs: string } {
  const r = spawnSync(process.execPath, [MAKE_DELTA, tree, installer, out], {
    encoding: 'utf8',
    env: { ...process.env, SENAWG_DELTA_CHUNK: String(CHUNK) }
  })
  expect(r.status, r.stderr).toBe(0)
  return { list: join(out, `${installer}.files.json`), blobs: join(out, 'blobs') }
}

/** Three chunks of the same random bytes in every test: the part of a big file that does not change. */
const BIG = crypto.randomBytes(3 * 64 * 1024)

const fromDisk =
  (blobs: string) =>
  async (sha: string): Promise<ReadableStream<Uint8Array>> =>
    Readable.toWeb(createReadStream(join(blobs, sha.slice(0, 2), `${sha}.br`))) as ReadableStream<Uint8Array>

const manifest = (entries: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ format: FILES_FORMAT, os: 'linux', version: '0.8.1', blobs: '../blobs/', entries, ...extra })
const SHA = 'a'.repeat(64)
/** An installed version with nothing to give. */
const NOTHING = { files: new Map<string, string>(), chunks: new Map() }
const MiB = 1024 * 1024
/** The chunk make-delta cuts with here: the smallest a list may name, so the tests stay light. */
const CHUNK = 64 * 1024
const file = (path: string) => ({ path, type: 'file', mode: 0o644, size: 1, sha256: SHA, packed: 1 })

describe('parseManifest', () => {
  it('takes what make-delta writes', async () => {
    await release(join(work, 'tree'), 'v2')
    const { list } = makeDelta(join(work, 'tree'), 'SenAWG-0.8.1-linux-x64.run', join(work, 'out'))
    const m = parseManifest(await readFile(list, 'utf8'))
    expect(m).toMatchObject({ os: 'linux', version: '0.8.1', blobs: '../blobs/' })
    expect(m.entries.find((e) => e.path === 'resources/current.pak')).toEqual({ path: 'resources/current.pak', type: 'link', target: 'deep/a.pak' })
    expect(m.entries.find((e) => e.path === 'senawg')).toMatchObject({ type: 'file', mode: 0o755 })
  })

  it.each([
    ['a path out of the tree', [file('../evil')]],
    ['an absolute path', [file('/etc/passwd')]],
    ['a path through ..', [{ path: 'a', type: 'dir', mode: 0o755 }, file('a/../../evil')]],
    ['a path that is not normal', [{ path: 'a', type: 'dir', mode: 0o755 }, file('a//b')]],
    ['a backslash', [file('a\\b')]],
    ['a file in a folder the list does not name', [file('nowhere/x')]],
    ['the same path twice', [file('x'), file('x')]],
    ['a link out of the tree', [{ path: 'l', type: 'link', target: '../../etc/passwd' }]],
    ['an absolute link', [{ path: 'l', type: 'link', target: '/etc/passwd' }]],
    ['a hash that is not one', [{ ...file('x'), sha256: 'zz' }]],
    ['a mode beyond permissions', [{ ...file('x'), mode: 0o4755 }]],
    ['an unknown kind', [{ path: 'x', type: 'fifo' }]],
    ['a name Windows reads as a stream', [file('a:evil')]],
    ['chunks that do not add up to the file', [{ ...file('x'), size: 3, chunks: [{ sha256: SHA, size: 1, packed: 1 }] }]],
    ['a chunk short of the chunk size before the last', [{ ...file('x'), size: 2 * MiB, chunks: [{ sha256: SHA, size: MiB - 1, packed: 1 }, { sha256: SHA, size: MiB + 1, packed: 1 }] }]],
    ['an empty chunk', [{ ...file('x'), size: 0, chunks: [{ sha256: SHA, size: 0, packed: 1 }] }]]
  ])('refuses %s', (_why, entries) => {
    expect(() => parseManifest(manifest(entries))).toThrow()
  })

  it('refuses another format, a strange blob address, no entries', () => {
    expect(() => parseManifest(manifest([file('x')], { format: 'other' }))).toThrow('формат')
    expect(() => parseManifest(manifest([file('x')], { blobs: 'https://evil.test/' }))).toThrow('адрес')
    expect(() => parseManifest(manifest([file('x')], { blobs: '/abs/' }))).toThrow('адрес')
    expect(() => parseManifest(manifest([]))).toThrow('нет файлов')
    expect(() => parseManifest('not json')).toThrow('не JSON')
  })
})

describe('assemble', () => {
  it('downloads only what changed, and the result is the new release byte for byte', async () => {
    await release(join(work, 'old'), 'v1')
    await release(join(work, 'new'), 'v2 — the new application code')
    const { list, blobs } = makeDelta(join(work, 'new'), 'SenAWG-0.8.1-linux-x64.run', join(work, 'out'))
    const m = parseManifest(await readFile(list, 'utf8'))

    const have = await hashTree(join(work, 'old'))
    expect(missingFiles(m, have).blobs.map((b) => b.path)).toEqual(['resources/app.asar'])

    const fetched: string[] = []
    const into = join(work, 'into')
    await mkdir(into)
    await assemble(m, have, into, async (sha) => {
      fetched.push(sha)
      return fromDisk(blobs)(sha)
    })
    expect(fetched).toHaveLength(1)
    expect(await readFile(join(into, 'resources', 'app.asar'), 'utf8')).toBe('v2 — the new application code')
    expect(await readlink(join(into, 'resources', 'current.pak'))).toBe('deep/a.pak')
    expect((await stat(join(into, 'senawg'))).mode & 0o777).toBe(0o755)
    // What make-delta sees in the result is what it saw in the release.
    const again = makeDelta(into, 'SenAWG-0.8.1-linux-x64.run', join(work, 'again'))
    expect(await readFile(again.list, 'utf8')).toBe(await readFile(list, 'utf8'))
  })

  it('a big file that changed near its end costs only the chunks there', async () => {
    // SenAWG.exe's shape: megabytes that stay, and its version near the end.
    const exe = (version: string) => Buffer.concat([crypto.randomBytes(0), BIG, Buffer.from(`FileVersion ${version}`), Buffer.alloc(1000, 3)])
    await release(join(work, 'old'), 'v1')
    await writeFile(join(work, 'old', 'big.exe'), exe('0.8.0'))
    await release(join(work, 'new'), 'v1')
    await writeFile(join(work, 'new', 'big.exe'), exe('0.8.1'))
    const { list, blobs } = makeDelta(join(work, 'new'), 'SenAWG-0.8.1-linux-x64.run', join(work, 'out'))
    const m = parseManifest(await readFile(list, 'utf8'))
    const big = m.entries.find((e) => e.path === 'big.exe')
    expect(big).toMatchObject({ type: 'file', chunks: expect.any(Array) })

    const have = await hashTree(join(work, 'old'), m.chunk)
    const missing = missingFiles(m, have)
    expect(missing.blobs).toHaveLength(1)
    expect(missing.blobs[0]).toMatchObject({ path: 'big.exe', size: BIG.length + 'FileVersion 0.8.1'.length + 1000 - 3 * CHUNK })

    const into = join(work, 'into')
    await mkdir(into)
    const fetched: string[] = []
    await assemble(m, have, into, async (sha) => {
      fetched.push(sha)
      return fromDisk(blobs)(sha)
    })
    expect(fetched).toEqual([missing.blobs[0].sha256])
    expect(await readFile(join(into, 'big.exe'))).toEqual(exe('0.8.1'))
  })

  it('chunks repeated across files are downloaded once', async () => {
    const block = crypto.randomBytes(CHUNK)
    await mkdir(join(work, 'new'))
    await writeFile(join(work, 'new', 'a.bin'), Buffer.concat([block, block, Buffer.from('a')]))
    await writeFile(join(work, 'new', 'b.bin'), Buffer.concat([block, Buffer.from('b')]))
    const { list, blobs } = makeDelta(join(work, 'new'), 'SenAWG-0.8.1-linux-x64.run', join(work, 'out'))
    const m = parseManifest(await readFile(list, 'utf8'))
    await mkdir(join(work, 'empty'))
    const have = await hashTree(join(work, 'empty'), m.chunk)
    // block, «a», block again (no), «b»: three blobs.
    expect(missingFiles(m, have).blobs).toHaveLength(3)
    const into = join(work, 'into')
    await mkdir(into)
    const fetched: string[] = []
    await assemble(m, have, into, async (sha) => {
      fetched.push(sha)
      return fromDisk(blobs)(sha)
    })
    expect(new Set(fetched).size).toBe(fetched.length)
    expect(fetched).toHaveLength(3)
  })

  it('a chunk that unpacks into something else is refused', async () => {
    await mkdir(join(work, 'new'))
    await writeFile(join(work, 'new', 'big.bin'), Buffer.concat([BIG, Buffer.from('x')]))
    const { list } = makeDelta(join(work, 'new'), 'SenAWG-0.8.1-linux-x64.run', join(work, 'out'))
    const m = parseManifest(await readFile(list, 'utf8'))
    const into = join(work, 'into')
    await mkdir(into)
    const forged = async (): Promise<ReadableStream<Uint8Array>> => new Blob([brotliCompressSync(Buffer.alloc(CHUNK, 9))]).stream()
    await expect(assemble(m, NOTHING, into, forged)).rejects.toThrow('не совпала')
  })

  it('a blob that is not the file it claims to be is refused', async () => {
    await release(join(work, 'new'), 'v2')
    const { list } = makeDelta(join(work, 'new'), 'SenAWG-0.8.1-linux-x64.run', join(work, 'out'))
    const m = parseManifest(await readFile(list, 'utf8'))
    const into = join(work, 'into')
    await mkdir(into)
    const forged = async (): Promise<ReadableStream<Uint8Array>> => new Blob([brotliCompressSync(Buffer.from('v3'))]).stream()
    await expect(assemble(m, NOTHING, into, forged)).rejects.toThrow()
  })

  it('a blob that unpacks into more than its file is stopped', async () => {
    const big = Buffer.alloc(1024 * 1024, 7)
    const packed = brotliCompressSync(big)
    const m: FilesManifest = {
      os: 'linux',
      version: '0.8.1',
      blobs: '../blobs/',
      chunk: 1024 * 1024,
      entries: [{ path: 'x', type: 'file', mode: 0o644, size: 10, sha256: SHA, packed: packed.length }]
    }
    const into = join(work, 'into')
    await mkdir(into)
    await expect(assemble(m, NOTHING, into, async () => new Blob([packed]).stream())).rejects.toThrow('распаковано больше')
  })

  it('verifyTree notices a file the list does not name', async () => {
    await release(join(work, 'new'), 'v2')
    const { list } = makeDelta(join(work, 'new'), 'SenAWG-0.8.1-linux-x64.run', join(work, 'out'))
    const m = parseManifest(await readFile(list, 'utf8'))
    await verifyTree(join(work, 'new'), m)
    await writeFile(join(work, 'new', 'extra'), '')
    await expect(verifyTree(join(work, 'new'), m)).rejects.toThrow('лишний')
  })
})

describe('serverSource: an update in pieces', () => {
  const ORIGIN = 'https://updates.test'
  const KEY = crypto.generateKeyPairSync('ed25519')
  const KEYS = [KEY.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')]
  const NAME = 'SenAWG-0.8.1-linux-x64.run'
  const runOf = (size: number) => Buffer.concat([Buffer.from('#!/bin/sh\n'), Buffer.alloc(size, 1)])
  const sign = (name: string, body: Buffer) =>
    crypto.sign(null, Buffer.from(updateMessage('linux', name, body.length, crypto.createHash('sha256').update(body).digest('hex'))), KEY.privateKey).toString('base64')

  /** The site after a deploy: the installer, the list, both signed, and the blobs in releases/blobs/. */
  async function site(
    opts: {
      listSig?: string
      noList?: boolean
      runSize?: number
      /** Called for every request (n counts the requests to that path): a Response answers instead, a throw is a dropped connection. */
      hook?: (path: string, method: string, n: number) => Response | undefined
      /** The installer answers ranges unless told not to; `cutAt`: its first GET stops after that many bytes. */
      ignoreRange?: boolean
      cutAt?: number
      /** The test has put the new release in work/new itself. */
      keepNew?: boolean
    } = {}
  ) {
    const RUN = runOf(opts.runSize ?? 4000)
    if (!opts.keepNew) await release(join(work, 'new'), 'v2 — the new application code')
    const { list, blobs } = makeDelta(join(work, 'new'), NAME, join(work, 'out'))
    const listBody = await readFile(list)
    const calls: string[] = []
    const seen = new Map<string, number>()
    let installerGets = 0
    const fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      const path = new URL(url).pathname
      const n = (seen.get(path) ?? 0) + 1
      seen.set(path, n)
      const injected = opts.hook?.(path, init?.method ?? 'GET', n)
      if (injected) return injected
      if (path === '/api/page/downloads/linux') {
        return new Response(JSON.stringify({ success: true, version: '0.8.1', url: `/downloads/releases/0.8.1/${NAME}` }))
      }
      if (path.endsWith(`${NAME}.files.json`)) return opts.noList ? new Response('', { status: 404 }) : new Response(listBody)
      if (path.endsWith(`${NAME}.files.json.sig`)) return new Response(opts.listSig ?? sign(`${NAME}.files.json`, listBody))
      if (path.endsWith(`${NAME}.sig`)) return new Response(sign(NAME, RUN))
      if (path.startsWith('/downloads/releases/blobs/')) {
        const sha = path.split('/').pop()!.replace(/\.br$/, '')
        return new Response(await readFile(join(blobs, sha.slice(0, 2), `${sha}.br`)))
      }
      if (path.endsWith(NAME)) {
        if (init?.method === 'HEAD') return new Response(null, { headers: { 'content-length': String(RUN.length) } })
        const range = new Headers(init?.headers).get('range')
        const start = range && !opts.ignoreRange ? Number(/bytes=(\d+)-/.exec(range)?.[1]) : 0
        const body = RUN.subarray(start)
        const cut = installerGets++ === 0 && opts.cutAt !== undefined ? opts.cutAt : undefined
        const stream =
          cut === undefined
            ? body
            : // The first bytes arrive, then the connection dies: delivered one pull at a time, because a stream that
              // errors straight after enqueueing drops what it queued.
              (() => {
                let pulls = 0
                return new ReadableStream<Uint8Array>({
                  pull(c) {
                    if (pulls++ === 0) c.enqueue(body.subarray(0, cut))
                    else c.error(new TypeError('terminated'))
                  }
                })
              })()
        return start > 0
          ? new Response(stream, { status: 206, headers: { 'content-range': `bytes ${start}-${RUN.length - 1}/${RUN.length}`, 'content-length': String(body.length) } })
          : new Response(stream, { headers: { 'content-length': String(RUN.length) } })
      }
      return new Response('', { status: 404 })
    }) as typeof globalThis.fetch
    return { fetch, calls }
  }

  const source = (fetch: typeof globalThis.fetch, logs: string[] = []) =>
    serverSource({
      fetch,
      current: '0.8.0',
      dir: work,
      origin: ORIGIN,
      os: 'linux',
      keys: KEYS,
      installed: () => ({ dir: join(work, 'old') }),
      log: (_l, m) => logs.push(m),
      // No waiting in the tests, and a stalled stream is cut quickly.
      resilience: { sleep: async () => undefined, headersMs: 2000, idleMs: 300 }
    })

  it('puts the new version together from the installed one and the changed file', async () => {
    await release(join(work, 'old'), 'v1')
    const s = await site()
    const src = source(s.fetch)
    const totals: (number | undefined)[] = []
    const end = await src.download((await src.check()) as Found, (_r, total) => totals.push(total))
    expect(end.kind).toBe('ready')
    const tree = (end as { file: string }).file
    expect((await stat(tree)).isDirectory()).toBe(true)
    expect(await readFile(join(tree, 'resources', 'app.asar'), 'utf8')).toBe('v2 — the new application code')
    // One blob, and never the installer itself.
    expect(s.calls.filter((c) => c.includes('/blobs/'))).toHaveLength(1)
    expect(s.calls.some((c) => c.startsWith('GET') && c.endsWith(NAME))).toBe(false)
    expect(totals[0]).toBeLessThan(4000)

    // Downloaded again (the application restarted before installing): the earlier folder does not stay.
    const again = source(s.fetch)
    await again.download((await again.check()) as Found, () => {})
    expect((await readdir(work)).filter((f) => f.startsWith('senawg-tree-'))).toHaveLength(1)
  })

  it('a list whose signature does not verify: the whole installer instead', async () => {
    await release(join(work, 'old'), 'v1')
    const s = await site({ listSig: sign('something else', Buffer.from('x')) })
    const logs: string[] = []
    const src = source(s.fetch, logs)
    const end = await src.download((await src.check()) as Found, () => {})
    expect((end as { file: string }).file).toBe(join(work, NAME))
    expect(logs.join('\n')).toMatch(/целиком: подпись списка файлов не сошлась/)
    expect(s.calls.some((c) => c.includes('/blobs/'))).toBe(false)
    expect((await readdir(work)).filter((f) => f.startsWith('senawg-tree-'))).toEqual([])
  })

  it('a copy that does not update in pieces says why in the journal', async () => {
    const s = await site()
    const logs: string[] = []
    const src = serverSource({ fetch: s.fetch, current: '0.8.0', dir: work, origin: ORIGIN, os: 'linux', keys: KEYS, log: (_l, m) => logs.push(m) })
    const end = await src.download((await src.check()) as Found, () => {})
    expect((end as { file: string }).file).toBe(join(work, NAME))
    expect(logs).toEqual(['Обновление 0.8.1 скачивается целиком: эта копия не обновляется по частям'])
  })

  it('a release without a list: the whole installer', async () => {
    await release(join(work, 'old'), 'v1')
    const s = await site({ noList: true })
    const src = source(s.fetch)
    const end = await src.download((await src.check()) as Found, () => {})
    expect((end as { file: string }).file).toBe(join(work, NAME))
  })

  it('when most of it changed, the installer is the smaller download', async () => {
    // Nothing in common with the new release, and an installer smaller than the blobs it would take.
    await mkdir(join(work, 'old'))
    const s = await site({ runSize: 10 })
    const logs: string[] = []
    const src = source(s.fetch, logs)
    const end = await src.download((await src.check()) as Found, () => {})
    expect((end as { file: string }).file).toBe(join(work, NAME))
    expect(logs.join('\n')).toMatch(/изменилась большая часть файлов/)
  })

  describe('when the server drops requests (a few in a hundred do)', () => {
    const blobPath = (p: string): boolean => p.startsWith('/downloads/releases/blobs/')
    const delta = async (fetch: typeof globalThis.fetch, logs: string[] = []) => {
      const src = source(fetch, logs)
      const end = await src.download((await src.check()) as Found, () => {})
      return { end: end as { file: string }, logs }
    }

    it('a list that fails once is asked for again, and the update stays in pieces', async () => {
      await release(join(work, 'old'), 'v1')
      const s = await site({ hook: (p, _m, n) => (p.endsWith('.files.json') && n === 1 ? new Response('', { status: 503 }) : undefined) })
      const { end, logs } = await delta(s.fetch)
      expect((await stat(end.file)).isDirectory()).toBe(true)
      expect(logs.join('\n')).toMatch(/список файлов — .*503; повтор 2 из 5/)
      expect(logs.join('\n')).not.toMatch(/целиком/)
      expect(s.calls.filter((c) => c.endsWith('.files.json'))).toHaveLength(2)
      expect(s.calls.some((c) => c.startsWith('GET') && c.endsWith(NAME))).toBe(false)
    })

    it('a connection that dies on a blob twice: that blob is fetched a third time, nothing else again', async () => {
      await release(join(work, 'old'), 'v1')
      const s = await site({
        hook: (p, _m, n) => {
          if (blobPath(p) && n <= 2) throw new TypeError('fetch failed')
          return undefined
        }
      })
      const { end, logs } = await delta(s.fetch)
      expect(await readFile(join(end.file, 'resources', 'app.asar'), 'utf8')).toBe('v2 — the new application code')
      expect(s.calls.filter((c) => c.includes('/blobs/'))).toHaveLength(3)
      expect(logs.filter((l) => /файл обновления — fetch failed; повтор/.test(l))).toHaveLength(2)
      expect(s.calls.filter((c) => c.endsWith('.files.json'))).toHaveLength(1)
    })

    it('a blob whose body stops halfway is fetched again, and the progress does not run ahead', async () => {
      await release(join(work, 'old'), 'v1')
      const s = await site({
        hook: (p, _m, n) => {
          if (!blobPath(p) || n > 1) return undefined
          return new Response(new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new Uint8Array([1, 2, 3])) /* and never ends */ }))
        }
      })
      const src = source(s.fetch)
      const seen: number[] = []
      const end = (await src.download((await src.check()) as Found, (r) => seen.push(r))) as { file: string }
      expect((await stat(end.file)).isDirectory()).toBe(true)
      const total = (await readdir(join(work, 'out', 'blobs'), { recursive: true })).length
      expect(total).toBeGreaterThan(0)
      // Never more than the real size of what was needed, even though three bytes were counted before the stall.
      expect(Math.max(...seen)).toBeLessThan(4000)
      expect(seen[seen.length - 1]).toBeGreaterThan(0)
    })

    it('a blob that is not there (404) is not asked for again: the installer instead, with the reason', async () => {
      await release(join(work, 'old'), 'v1')
      const s = await site({ hook: (p) => (blobPath(p) ? new Response('', { status: 404 }) : undefined) })
      const { end, logs } = await delta(s.fetch)
      expect(end.file).toBe(join(work, NAME))
      expect(s.calls.filter((c) => c.includes('/blobs/'))).toHaveLength(1)
      expect(logs.join('\n')).toMatch(/целиком: файл обновления недоступен: 404/)
    })

    it('a server that keeps failing a blob: five tries, then the installer, with the reason', async () => {
      await release(join(work, 'old'), 'v1')
      const s = await site({ hook: (p) => (blobPath(p) ? new Response('', { status: 502 }) : undefined) })
      const { end, logs } = await delta(s.fetch)
      expect(end.file).toBe(join(work, NAME))
      expect(s.calls.filter((c) => c.includes('/blobs/'))).toHaveLength(5)
      expect(logs.join('\n')).toMatch(/целиком: файл обновления недоступен: 502/)
    })

    it('the version check and the size of the installer are asked again too', async () => {
      const s = await site({
        hook: (p, m, n) => {
          if (p === '/api/page/downloads/linux' && n === 1) throw new TypeError('fetch failed')
          if (m === 'HEAD' && n === 1) return new Response('', { status: 500 })
          return undefined
        }
      })
      const logs: string[] = []
      const found = (await source(s.fetch, logs).check()) as Found
      expect(found.version).toBe('0.8.1')
      expect(found.total).toBeGreaterThan(0)
      expect(logs.join('\n')).toMatch(/проверка версии — fetch failed; повтор 2 из 5/)
      expect(logs.join('\n')).toMatch(/размер установщика — .*500; повтор 2 из 5/)
    })

    it('a 404 from the version check is still reported as it was', async () => {
      const s = await site({ hook: (p) => (p === '/api/page/downloads/linux' ? new Response('', { status: 404 }) : undefined) })
      await expect(source(s.fetch).check()).rejects.toThrow('Сервер обновлений ответил 404')
    })
  })

  describe('the changed files, a few at a time', () => {
    /** Two changed files and a big one that changed near its end: several blobs, so there is something to run side by side. */
    async function manyBlobs(): Promise<void> {
      const exe = (v: string) => Buffer.concat([BIG, Buffer.from(`FileVersion ${v}`), Buffer.alloc(1000, 3)])
      for (const [dir, v] of [['old', '1'], ['new', '2']] as const) {
        await release(join(work, dir), `app ${v} — ${'x'.repeat(200)}`)
        await writeFile(join(work, dir, 'a.bin'), `file a ${v}`)
        await writeFile(join(work, dir, 'b.bin'), `file b ${v}`)
        await writeFile(join(work, dir, 'c.bin'), `file c ${v}`)
        await writeFile(join(work, dir, 'big.exe'), exe(v))
      }
    }
    const blobGate = () => {
      let inFlight = 0
      const state = { max: 0, total: 0 }
      const hook = (p: string): Response | undefined => {
        if (!p.startsWith('/downloads/releases/blobs/')) return undefined
        state.total++
        state.max = Math.max(state.max, ++inFlight)
        return undefined
      }
      return { state, hook, done: () => void inFlight-- }
    }

    it('are fetched three at a time, never more, and the progress ends at their size', async () => {
      await manyBlobs()
      const s = await site({ keepNew: true })
      let inFlight = 0
      let max = 0
      const slow = (async (input: string | URL, init?: RequestInit) => {
        const slowBlob = new URL(String(input)).pathname.startsWith('/downloads/releases/blobs/')
        if (slowBlob) max = Math.max(max, ++inFlight)
        try {
          if (slowBlob) await new Promise((r) => setTimeout(r, 15))
          return await s.fetch(input, init)
        } finally {
          if (slowBlob) inFlight--
        }
      }) as typeof globalThis.fetch
      const src = source(slow)
      const seen: number[] = []
      const totals: (number | undefined)[] = []
      const end = (await src.download((await src.check()) as Found, (r, t) => (seen.push(r), totals.push(t)))) as { file: string }
      expect((await stat(end.file)).isDirectory()).toBe(true)
      expect(await readFile(join(end.file, 'a.bin'), 'utf8')).toBe('file a 2')
      expect(max).toBeGreaterThan(1)
      expect(max).toBeLessThanOrEqual(3)
      // Rises to what the changed files weigh and never past it.
      const packed = totals.find((t) => t !== undefined && t > 0)!
      expect(Math.max(...seen)).toBe(packed)
      expect(seen[seen.length - 1]).toBe(packed)
      expect(seen.every((v, i) => i === 0 || v >= seen[i - 1])).toBe(true)
    })

    it('one that fails on the way is fetched again while the others go on', async () => {
      await manyBlobs()
      let failed = 0
      const s = await site({
        keepNew: true,
        hook: (p) => {
          if (p.startsWith('/downloads/releases/blobs/') && failed < 2) {
            failed++
            throw new TypeError('fetch failed')
          }
          return undefined
        }
      })
      const logs: string[] = []
      const src = source(s.fetch, logs)
      const end = (await src.download((await src.check()) as Found, () => {})) as { file: string }
      expect(await readFile(join(end.file, 'c.bin'), 'utf8')).toBe('file c 2')
      expect(logs.filter((l) => /файл обновления — fetch failed; повтор/.test(l))).toHaveLength(2)
      expect(logs.join('\n')).not.toMatch(/целиком/)
    })

    it('a blob that came back cut short is fetched again from the server, not taken from memory twice', async () => {
      await manyBlobs()
      const real = new Map<string, Uint8Array>()
      let cut = 0
      const s = await site({ keepNew: true })
      const truncating = (async (input: string | URL, init?: RequestInit) => {
        const res = await s.fetch(input, init)
        const path = new URL(String(input)).pathname
        if (!path.startsWith('/downloads/releases/blobs/')) return res
        const bytes = new Uint8Array(await res.arrayBuffer())
        real.set(path, bytes)
        // The first blob arrives short and the body just ends, as when a connection closes politely too early.
        if (cut++ === 0 && bytes.length > 4) return new Response(bytes.subarray(0, bytes.length - 4))
        return new Response(bytes)
      }) as typeof globalThis.fetch
      const src = source(truncating)
      const end = (await src.download((await src.check()) as Found, () => {})) as { file: string }
      expect(await readFile(join(end.file, 'a.bin'), 'utf8')).toBe('file a 2')
      // The cut blob was asked for a second time.
      expect(cut).toBeGreaterThan(real.size)
    })

    it('a prefetch that cannot finish ends in the whole installer, with the reason', async () => {
      await manyBlobs()
      const s = await site({ keepNew: true, hook: (p) => (p.startsWith('/downloads/releases/blobs/') ? new Response('', { status: 503 }) : undefined) })
      const logs: string[] = []
      const src = source(s.fetch, logs)
      const end = (await src.download((await src.check()) as Found, () => {})) as { file: string }
      expect(end.file).toBe(join(work, NAME))
      expect(logs.join('\n')).toMatch(/целиком: файл обновления недоступен: 503/)
    })

    it('too many bytes to hold in memory: one after another, as before', async () => {
      await manyBlobs()
      const s = await site({ keepNew: true })
      const { state, hook, done } = blobGate()
      const gated = (async (input: string | URL, init?: RequestInit) => {
        const p = new URL(String(input)).pathname
        hook(p)
        try {
          return await s.fetch(input, init)
        } finally {
          if (p.startsWith('/downloads/releases/blobs/')) done()
        }
      }) as typeof globalThis.fetch
      const src = serverSource({
        fetch: gated,
        current: '0.8.0',
        dir: work,
        origin: ORIGIN,
        os: 'linux',
        keys: KEYS,
        installed: () => ({ dir: join(work, 'old') }),
        prefetchBytes: 1,
        resilience: { sleep: async () => undefined }
      })
      const end = (await src.download((await src.check()) as Found, () => {})) as { file: string }
      expect(await readFile(join(end.file, 'b.bin'), 'utf8')).toBe('file b 2')
      expect(state.total).toBeGreaterThan(1)
    })
  })

  describe('the whole installer, when it has to be one', () => {
    it('a connection that drops halfway is continued from where it stopped, and the signature still checks', async () => {
      const s = await site({ runSize: 6000, cutAt: 2500 })
      const logs: string[] = []
      const src = serverSource({ fetch: s.fetch, current: '0.8.0', dir: work, origin: ORIGIN, os: 'linux', keys: KEYS, log: (_l, m) => logs.push(m), resilience: { sleep: async () => undefined } })
      const end = (await src.download((await src.check()) as Found, () => {})) as { file: string }
      expect(end.file).toBe(join(work, NAME))
      expect((await readFile(end.file)).equals(runOf(6000))).toBe(true)
      const gets = s.calls.filter((c) => c.startsWith('GET') && c.endsWith(NAME))
      expect(gets).toHaveLength(2)
      expect(logs.join('\n')).toMatch(/установщик — terminated; повтор 2 из 5, докачка с 0\.0 МБ/)
    })

    it('a server that ignores the range sends it all again, and that is accepted', async () => {
      const s = await site({ runSize: 6000, cutAt: 2500, ignoreRange: true })
      const src = serverSource({ fetch: s.fetch, current: '0.8.0', dir: work, origin: ORIGIN, os: 'linux', keys: KEYS, resilience: { sleep: async () => undefined } })
      const end = (await src.download((await src.check()) as Found, () => {})) as { file: string }
      expect((await readFile(end.file)).equals(runOf(6000))).toBe(true)
    })

    it('a file that was continued wrongly does not pass the signature, and is removed', async () => {
      const s = await site({ runSize: 6000, cutAt: 2500 })
      // The continuation comes from another file: right length, wrong bytes.
      const lying = (async (input: string | URL, init?: RequestInit) => {
        const res = await s.fetch(input, init)
        if (new Headers(init?.headers).get('range') && res.status === 206) return new Response(Buffer.alloc(runOf(6000).length - 2500, 9), { status: 206, headers: res.headers })
        return res
      }) as typeof globalThis.fetch
      const src = serverSource({ fetch: lying, current: '0.8.0', dir: work, origin: ORIGIN, os: 'linux', keys: KEYS, resilience: { sleep: async () => undefined } })
      await expect(src.download((await src.check()) as Found, () => {})).rejects.toThrow(/Подпись обновления не сошлась/)
      expect((await readdir(work)).includes(NAME)).toBe(false)
    })

    it('a server that cannot give the rest at all ends the download with a reason', async () => {
      const s = await site({ runSize: 6000, cutAt: 2500, hook: (p, m, n) => (p.endsWith(NAME) && m === 'GET' && n >= 3 ? new Response('', { status: 416 }) : undefined) })
      const src = serverSource({ fetch: s.fetch, current: '0.8.0', dir: work, origin: ORIGIN, os: 'linux', keys: KEYS, resilience: { sleep: async () => undefined } })
      await expect(src.download((await src.check()) as Found, () => {})).rejects.toThrow(/не докачался: 416/)
      expect((await readdir(work)).includes(NAME)).toBe(false)
    })
  })
})
