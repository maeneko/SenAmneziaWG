import { createServer, type Server, type Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HelperClient } from '../src/main/tunnel/windows/helperClient'
import { HelperError } from '../src/main/tunnel/windows/protocol'

let n = 0
/** A unix socket stands in for the helper's named pipe: same stream semantics, testable on any OS. */
const socketPath = (dir: string): string => (process.platform === 'win32' ? String.raw`\\.\pipe\awg-test-${process.pid}-${n++}` : join(dir, 's.sock'))

describe('HelperClient', () => {
  let dir: string
  let server: Server | null
  let received: string[]

  const serve = (onConnection: (sock: Socket, line: string) => void): string => {
    const path = socketPath(dir)
    server = createServer((sock) => {
      let buf = ''
      sock.setEncoding('utf8')
      sock.on('data', (chunk: string) => {
        buf += chunk
        const end = buf.indexOf('\n')
        if (end === -1) return
        received.push(buf.slice(0, end))
        onConnection(sock, buf.slice(0, end))
      })
      sock.on('error', () => {})
    }).listen(path)
    return path
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'awgpipe-'))
    server = null
    received = []
  })
  afterEach(() => {
    server?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('sends one JSON line with the protocol version and resolves the reply', async () => {
    const path = serve((sock) => sock.end(JSON.stringify({ ok: true, iface: 'AmnesiaWG' }) + '\n'))
    const res = await new HelperClient(path).request({ op: 'up', id: 'abc', conf: '[Interface]\n', replace: true })
    expect(res).toEqual({ ok: true, iface: 'AmnesiaWG' })
    expect(JSON.parse(received[0])).toEqual({ v: 1, op: 'up', id: 'abc', conf: '[Interface]\n', replace: true })
  })

  it('reassembles a reply that arrives in pieces', async () => {
    const path = serve((sock) => {
      sock.write('{"ok":tr')
      setTimeout(() => sock.end('ue,"uapi":"rx_bytes=1"}\n'), 20)
    })
    expect((await new HelperClient(path).request({ op: 'stats' })).uapi).toBe('rx_bytes=1')
  })

  it('turns {ok:false} into a HelperError carrying the code and the message written for the user', async () => {
    const path = serve((sock) => sock.end(JSON.stringify({ ok: false, code: 'BUSY', error: 'Туннель уже активен' }) + '\n'))
    const err = await new HelperClient(path).request({ op: 'up' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HelperError)
    expect(err).toMatchObject({ message: 'Туннель уже активен', code: 'BUSY' })
  })

  it('reports a garbled reply', async () => {
    const path = serve((sock) => sock.end('this is not json\n'))
    await expect(new HelperClient(path).request({ op: 'status' })).rejects.toMatchObject({ code: 'BAD_RESPONSE' })
  })

  it('reports a service that hangs up without answering', async () => {
    const path = serve((sock) => sock.end())
    await expect(new HelperClient(path).request({ op: 'status' })).rejects.toMatchObject({ code: 'CLOSED' })
  })

  it('gives up on a service that never answers', async () => {
    const path = serve(() => {})
    await expect(new HelperClient(path).request({ op: 'status' }, 60)).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('says the service is not running when there is no pipe', async () => {
    const err = await new HelperClient(socketPath(dir)).request({ op: 'hello' }).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'NOT_RUNNING' })
    expect((err as Error).message).toMatch(/Служба AmnesiaWG не запущена/)
  })
})
