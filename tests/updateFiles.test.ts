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
  async function site(opts: { listSig?: string; noList?: boolean; runSize?: number } = {}) {
    const RUN = runOf(opts.runSize ?? 4000)
    await release(join(work, 'new'), 'v2 — the new application code')
    const { list, blobs } = makeDelta(join(work, 'new'), NAME, join(work, 'out'))
    const listBody = await readFile(list)
    const calls: string[] = []
    const fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      const path = new URL(url).pathname
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
      if (path.endsWith(NAME)) return new Response(init?.method === 'HEAD' ? null : RUN, { headers: { 'content-length': String(RUN.length) } })
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
      log: (_l, m) => logs.push(m)
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
})
