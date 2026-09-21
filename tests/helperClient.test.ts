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

  const serve = (onConnection: (sock: Socket, line: string) => void, path = socketPath(dir)): string => {
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
    expect(JSON.parse(received[0])).toEqual({ v: 1, pid: process.pid, op: 'up', id: 'abc', conf: '[Interface]\n', replace: true })
  })

  it('tells the service which process to watch, on every verb', async () => {
    const path = serve((sock) => sock.end('{"ok":true}\n'))
    const client = new HelperClient(path)
    await client.request({ op: 'status' })
    await client.request({ op: 'stats' })
    // The service stops the tunnel once this process is gone, so it must always know which one it is.
    expect(received.map((r) => JSON.parse(r).pid)).toEqual([process.pid, process.pid])
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

  describe('starting the service when it is not running', () => {
    const answer = (sock: Socket): void => void sock.end('{"ok":true}\n')

    it('starts it and sends the request once the pipe is there', async () => {
      const path = socketPath(dir)
      let starts = 0
      const start = async (): Promise<number> => {
        starts++
        setTimeout(() => serve(answer, path), 50) // the pipe appears a moment after the SCM says «started»
        return 0
      }
      await expect(new HelperClient(path, start).request({ op: 'hello' })).resolves.toEqual({ ok: true })
      expect(starts).toBe(1)
    })

    it('starts it once for every request that found it down at the same time', async () => {
      const path = socketPath(dir)
      let starts = 0
      const start = async (): Promise<number> => {
        starts++
        setTimeout(() => serve(answer, path), 50)
        return 0
      }
      const client = new HelperClient(path, start)
      await Promise.all([client.request({ op: 'hello' }), client.request({ op: 'status' }), client.request({ op: 'stats' })])
      expect(starts).toBe(1)
      expect(received).toHaveLength(3)
    })

    it('waits out a previous instance that is still stopping', async () => {
      const path = socketPath(dir)
      const codes = [1061, 1061, 0] // ERROR_SERVICE_CANNOT_ACCEPT_CTRL while it stops, then started
      const start = async (): Promise<number> => {
        const code = codes.shift() ?? 0
        if (code === 0) setTimeout(() => serve(answer, path), 20)
        return code
      }
      await expect(new HelperClient(path, start).request({ op: 'status' })).resolves.toEqual({ ok: true })
      expect(codes).toHaveLength(0)
    })

    it.each([
      [1060, 'NOT_INSTALLED', /не установлена/],
      [5, 'NO_ACCESS', /обновите AmnesiaWG/],
      [1058, 'DISABLED', /отключена/],
      [-1, 'NOT_RUNNING', /запустить её не удалось/] // sc.exe could not be run at all
    ])('gives up at once on code %i: %s', async (code, errCode, message) => {
      let starts = 0
      const start = async (): Promise<number> => {
        starts++
        return code
      }
      const err = await new HelperClient(socketPath(dir), start).request({ op: 'hello' }).catch((e: unknown) => e)
      expect(err).toMatchObject({ code: errCode })
      expect((err as Error).message).toMatch(message)
      expect(starts).toBe(1)
    })

    it('does not try to start anything for other failures', async () => {
      let starts = 0
      const path = serve((sock) => sock.end(JSON.stringify({ ok: false, code: 'BUSY', error: 'Туннель уже активен' }) + '\n'))
      const err = await new HelperClient(path, async () => ++starts && 0).request({ op: 'up' }).catch((e: unknown) => e)
      expect(err).toMatchObject({ code: 'BUSY' })
      expect(starts).toBe(0)
    })
  })

  it('says the service is not running when there is no pipe', async () => {
    const err = await new HelperClient(socketPath(dir)).request({ op: 'hello' }).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'NOT_RUNNING' })
    expect((err as Error).message).toMatch(/Служба AmnesiaWG не запущена/)
  })
})
