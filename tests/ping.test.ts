import { createSocket, type Socket } from 'node:dgram'
import { afterEach, describe, expect, it } from 'vitest'
import { best, buildQuery, isReplyTo, measurePing, pingTargets, probe } from '../src/main/tunnel/ping'

describe('buildQuery', () => {
  it('is one recursive A/IN question for <name>.example.com', () => {
    const q = buildQuery(0xbeef, 'abc')
    expect(q.readUInt16BE(0)).toBe(0xbeef)
    expect(q[2] & 0x01).toBe(1) // recursion desired
    expect(q.readUInt16BE(4)).toBe(1) // one question, no answers
    expect(q.readUInt16BE(6)).toBe(0)
    // 3abc7example3com0, then type A and class IN.
    expect(q.subarray(12).toString('latin1')).toBe('\x03abc\x07example\x03com\x00\x00\x01\x00\x01')
  })

  it('names of different lengths stay well formed', () => {
    const q = buildQuery(1, 'abcdefgh')
    expect(q[12]).toBe(8)
    expect(q.length).toBe(12 + 1 + 8 + 1 + 7 + 1 + 3 + 1 + 4)
  })
})

describe('isReplyTo', () => {
  const reply = (id: number, flags = 0x8180): Buffer => {
    const b = Buffer.alloc(12)
    b.writeUInt16BE(id, 0)
    b.writeUInt16BE(flags, 2)
    return b
  }

  it('takes the answer to our own question', () => {
    expect(isReplyTo(reply(0x1234), 0x1234)).toBe(true)
  })

  it('refuses another id, a question, and anything too short', () => {
    expect(isReplyTo(reply(0x1234), 0x9999)).toBe(false)
    expect(isReplyTo(reply(0x1234, 0x0100), 0x1234)).toBe(false) // not a response
    expect(isReplyTo(Buffer.from([0x12, 0x34]), 0x1234)).toBe(false)
  })
})

describe('best', () => {
  it('keeps the smallest sample: jitter only ever adds delay', () => {
    expect(best([48.2, 31.7, 96.0])).toBe(32)
  })

  it('ignores the probes that never came back', () => {
    expect(best([null, 12.4, null])).toBe(12)
  })

  it('is null when nothing answered at all', () => {
    expect(best([null, null, null])).toBeNull()
  })
})

describe('pingTargets', () => {
  it('asks the resolver the tunnel pushed', () => {
    expect(pingTargets(['10.8.1.1', '10.8.1.2'])).toEqual(['10.8.1.1', '10.8.1.2'])
  })

  it('falls back to a public one when the configuration names none', () => {
    expect(pingTargets([])[0]).toBe('1.1.1.1')
  })

  it('skips what a udp4 socket cannot send to', () => {
    expect(pingTargets(['2606:4700:4700::1111', 'dns.example.com'])[0]).toBe('1.1.1.1')
  })
})

describe('probe', () => {
  let server: Socket | null = null

  afterEach(() => {
    server?.close()
    server = null
  })

  it('times out to null when nothing answers', async () => {
    // Nothing listens here, and a datagram into the void is simply lost.
    expect(await probe('127.0.0.1', 60)).toBeNull()
  })

  it('measures a real round trip against a resolver that answers', async () => {
    server = createSocket('udp4')
    await new Promise<void>((done) => server!.bind(0, '127.0.0.1', done))
    server.on('message', (message, from) => {
      const answer = Buffer.from(message)
      answer.writeUInt16BE(0x8180, 2) // flip the question into a response
      server!.send(answer, from.port, from.address)
    })
    const port = server.address().port

    // measurePing always asks port 53, so the probe itself is what gets a port to talk to.
    const ms = await probeOn('127.0.0.1', port)
    expect(ms).not.toBeNull()
    expect(ms!).toBeLessThan(60)
  })

  /** Same probe, but aimed at the test resolver's port. */
  function probeOn(host: string, port: number): Promise<number | null> {
    return new Promise((resolve) => {
      const id = 0x4242
      const socket = createSocket('udp4')
      const timer = setTimeout(() => {
        socket.close()
        resolve(null)
      }, 1000)
      const started = process.hrtime.bigint()
      socket.on('message', (message) => {
        if (!isReplyTo(message, id)) return
        clearTimeout(timer)
        socket.close()
        resolve(Number(process.hrtime.bigint() - started) / 1e6)
      })
      socket.send(buildQuery(id, 'probe'), port, host)
    })
  }
})

describe('measurePing', () => {
  it('is null when the resolver says nothing', async () => {
    // 192.0.2.0/24 is reserved for documentation: nothing there can answer.
    expect(await measurePing(['192.0.2.1'])).toBeNull()
  }, 10_000)
})
