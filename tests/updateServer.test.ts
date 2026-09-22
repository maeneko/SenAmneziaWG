import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isNewer, serverSource } from '../src/main/update/server'
import type { Found } from '../src/main/update/updater'

const ORIGIN = 'https://updates.test'
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(98, 1)])

interface Site {
  latest?: unknown
  status?: number
  file?: Buffer
  /** Content-Length the file claims, when it differs from what is sent. */
  length?: number
}

/** A fake site: the API answer, and one file served in two chunks. */
function site(s: Site) {
  const calls: string[] = []
  const fetch: typeof globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    if (url.startsWith(`${ORIGIN}/api/page/downloads/`)) {
      return new Response(JSON.stringify(s.latest), { status: s.status ?? 200 })
    }
    const file = s.file ?? EXE
    const headers = { 'content-length': String(s.length ?? file.length) }
    if (init?.method === 'HEAD') return new Response(null, { headers })
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(file.subarray(0, 40))
        c.enqueue(file.subarray(40))
        c.close()
      }
    })
    return new Response(body, { headers })
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

const latest = (version: string, url = `/downloads/releases/SenAWG-${version}-setup.exe`) => ({
  success: true,
  os: 'windows',
  version,
  url,
  os_version: '10'
})

describe('isNewer', () => {
  it.each([
    ['0.5.2', '0.5.1', true],
    ['0.5.10', '0.5.9', true],
    ['0.5.1', '0.5.1', false],
    ['0.5.0', '0.5.1', false],
    ['v0.6.0', '0.5.1', true],
    ['0.6.0', '0.6.0-beta', true],
    ['0.6.0-beta', '0.6.0', false],
    ['0.6.0-beta.2', '0.6.0-beta.10', false],
    ['1.0', '0.9.9', true]
  ])('%s over %s: %s', (a, b, expected) => expect(isNewer(a, b)).toBe(expected))
})

describe('serverSource', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'senawg-update-'))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  const source = (s: ReturnType<typeof site>, current = '0.5.1') =>
    serverSource({ fetch: s.fetch, current, dir, origin: ORIGIN })

  it('asks for Windows and finds a newer version, its size from the file', async () => {
    const s = site({ latest: latest('0.6.0') })
    expect(await source(s).check()).toEqual({ version: '0.6.0', notes: [], total: EXE.length })
    expect(s.calls).toEqual([
      `GET ${ORIGIN}/api/page/downloads/windows`,
      `HEAD ${ORIGIN}/downloads/releases/SenAWG-0.6.0-setup.exe`
    ])
  })

  it('the same or an older version is nothing new', async () => {
    expect(await source(site({ latest: latest('0.5.1') })).check()).toBeNull()
    expect(await source(site({ latest: latest('0.4.0') })).check()).toBeNull()
  })

  it('an error from the site, or an answer without a version, is a failure', async () => {
    await expect(source(site({ latest: { success: false }, status: 404 })).check()).rejects.toThrow('404')
    await expect(source(site({ latest: { success: false } })).check()).rejects.toThrow('без версии')
  })

  it('offers nothing that is not our installer, or lives elsewhere', async () => {
    const other = latest('5.1.0', '/downloads/releases/AmneziaVPN_5.1.0_windows_x64.exe')
    await expect(source(site({ latest: other })).check()).rejects.toThrow('не установщик SenAWG')
    const away = latest('0.6.0', 'https://evil.test/SenAWG-0.6.0-setup.exe')
    await expect(source(site({ latest: away })).check()).rejects.toThrow('чужой адрес')
  })

  it('downloads what the check found, reporting progress', async () => {
    const src = source(site({ latest: latest('0.6.0') }))
    const found = (await src.check()) as Found
    const seen: number[] = []
    const end = await src.download(found, (r) => seen.push(r))
    expect(end).toMatchObject({ kind: 'ready', version: '0.6.0', file: join(dir, 'SenAWG-0.6.0-setup.exe') })
    expect(seen).toEqual([40, EXE.length])
    expect(await readFile(join(dir, 'SenAWG-0.6.0-setup.exe'))).toEqual(EXE)
  })

  it('a download without a check before it is refused', async () => {
    const src = source(site({ latest: latest('0.6.0') }))
    await expect(src.download({ version: '0.6.0', notes: [], total: 1 }, () => {})).rejects.toThrow('больше не предлагается')
  })

  it('a short or foreign file is thrown away', async () => {
    const short = source(site({ latest: latest('0.6.0'), length: EXE.length + 10 }))
    await expect(short.download((await short.check()) as Found, () => {})).rejects.toThrow('не целиком')
    const html = source(site({ latest: latest('0.6.0'), file: Buffer.from('<!doctype html>') }))
    await expect(html.download((await html.check()) as Found, () => {})).rejects.toThrow('не программа Windows')
    expect(await readdir(dir)).toEqual([])
  })
})
