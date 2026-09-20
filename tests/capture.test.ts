import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureError, describeCapture, parseInnerCapture, parseOuterCapture } from '../src/main/tunnel/capture'

// Standard `tcpdump -l -n` output shapes.
const HDR = 'tcpdump: verbose output suppressed, use -v[v]... for full protocol decode\nlistening on utun4, link-type NULL (BSD loopback), snapshot length 524288 bytes\n'
const SYN = '14:13:05.100 IP 10.9.0.6.52311 > 1.1.1.1.443: Flags [S], seq 1, win 65535, options [mss 1336], length 0'
const SYNACK = '14:13:05.150 IP 1.1.1.1.443 > 10.9.0.6.52311: Flags [S.], seq 9, ack 2, win 65535, length 0'
const OUT = (n: number): string => `14:13:05.1 IP 10.178.197.58.56231 > 2.27.175.125.47619: UDP, length ${n}`
const IN = (n: number): string => `14:13:05.2 IP 2.27.175.125.47619 > 10.178.197.58.56231: UDP, length ${n}`

describe('parse', () => {
  it('splits outer UDP by direction', () => {
    const r = parseOuterCapture([OUT(238), OUT(174), IN(137), IN(92)].join('\n'), '2.27.175.125')
    expect(r).toEqual({ out: 2, in: 2, outSizes: [238, 174], inSizes: [137, 92] })
  })
  it('recognises tcpdump failures but not its banner', () => {
    expect(captureError(HDR)).toBeNull()
    expect(captureError('tcpdump: utun9: No such device exists\n')).toBe('utun9: No such device exists')
  })
})

/** Builds a DLT_NULL pcap like one captured on utun, so the real `tcpdump -r` can be exercised. */
function pcap(packets: Buffer[]): Buffer {
  const head = Buffer.alloc(24)
  head.writeUInt32LE(0xa1b2c3d4, 0); head.writeUInt16LE(2, 4); head.writeUInt16LE(4, 6)
  head.writeUInt32LE(65535, 16); head.writeUInt32LE(0, 20) // DLT_NULL
  const recs = packets.map((p, i) => {
    const rec = Buffer.alloc(16)
    rec.writeUInt32LE(1_789_000_000 + i, 0); rec.writeUInt32LE(p.length + 4, 8); rec.writeUInt32LE(p.length + 4, 12)
    const fam = Buffer.alloc(4); fam.writeUInt32LE(2, 0) // AF_INET, host order
    return Buffer.concat([rec, fam, p])
  })
  return Buffer.concat([head, ...recs])
}
const ipSum = (b: Buffer): number => {
  let s = 0
  for (let i = 0; i < b.length; i += 2) s += (b[i] << 8) + (b[i + 1] ?? 0)
  while (s >> 16) s = (s & 0xffff) + (s >> 16)
  return ~s & 0xffff
}
function ipv4(src: string, dst: string, proto: number, l4: Buffer): Buffer {
  const h = Buffer.alloc(20)
  h[0] = 0x45; h.writeUInt16BE(20 + l4.length, 2); h[8] = 64; h[9] = proto
  src.split('.').forEach((o, i) => (h[12 + i] = Number(o))); dst.split('.').forEach((o, i) => (h[16 + i] = Number(o)))
  h.writeUInt16BE(ipSum(h), 10)
  return Buffer.concat([h, l4])
}
function tcp(src: string, dst: string, sport: number, dport: number, flags: number, goodSum: boolean): Buffer {
  const t = Buffer.alloc(20)
  t.writeUInt16BE(sport, 0); t.writeUInt16BE(dport, 2); t.writeUInt32BE(1, 4); t[12] = 0x50; t[13] = flags; t.writeUInt16BE(65535, 14)
  const pseudo = Buffer.alloc(12)
  src.split('.').forEach((o, i) => (pseudo[i] = Number(o))); dst.split('.').forEach((o, i) => (pseudo[4 + i] = Number(o)))
  pseudo[9] = 6; pseudo.writeUInt16BE(20, 10)
  t.writeUInt16BE(goodSum ? ipSum(Buffer.concat([pseudo, t])) : 0x1234, 16)
  return ipv4(src, dst, 6, t)
}
function udp(src: string, dst: string, sport: number, dport: number): Buffer {
  const u = Buffer.alloc(8 + 12)
  u.writeUInt16BE(sport, 0); u.writeUInt16BE(dport, 2); u.writeUInt16BE(u.length, 4) // checksum 0 = none
  return ipv4(src, dst, 17, u)
}

describe.skipIf(process.platform !== 'darwin')('real tcpdump -r output', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'awgpcap-')), 'inner.pcap')
  writeFileSync(
    file,
    pcap([
      tcp('10.9.0.6', '1.1.1.1', 52311, 443, 0x02, false), // our SYN, broken checksum
      tcp('10.9.0.6', '8.8.8.8', 52312, 443, 0x02, true), // our SYN, fine
      tcp('1.1.1.1', '10.9.0.6', 443, 52311, 0x12, true), // SYN-ACK back
      udp('10.9.0.6', '1.1.1.1', 50000, 53),
      udp('1.1.1.1', '10.9.0.6', 53, 50000)
    ])
  )
  const read = (...extra: string[]): string =>
    spawnSync('/usr/sbin/tcpdump', ['-r', file, '-nn', ...extra], { encoding: 'utf8' }).stdout

  it('counts handshakes, directions and bad checksums', () => {
    expect(parseInnerCapture(read(), '10.9.0.6', read('-vv'))).toEqual({
      packets: 5, synOut: 2, synAckIn: 1, tcpOut: 2, tcpIn: 1, udpOut: 1, udpIn: 1, badChecksum: 1
    })
  })

  it('blames bad checksums when nothing comes back', () => {
    const only = join(mkdtempSync(join(tmpdir(), 'awgpcap-')), 'bad.pcap')
    writeFileSync(only, pcap([tcp('10.9.0.6', '1.1.1.1', 52311, 443, 0x02, false)]))
    const r = (...x: string[]): string => spawnSync('/usr/sbin/tcpdump', ['-r', only, '-nn', ...x], { encoding: 'utf8' }).stdout
    const lines = describeCapture(r(), '', '2.27.175.125', 'utun4', '10.9.0.6', r('-vv'))
    expect(lines.at(-1)?.message).toMatch(/неверной контрольной суммой \(1\)/)
  })
})

const verdict = (inner: string, outer: string): string =>
  describeCapture(inner, outer, '2.27.175.125', 'utun4', '10.9.0.6').map((l) => `${l.level}: ${l.message}`).join('\n')

describe('describeCapture', () => {
  it('SYN-ACKs reach the tunnel but the connection fails → macOS side', () =>
    expect(verdict(HDR + [SYN, SYNACK].join('\n'), [OUT(200), IN(180)].join('\n'))).toMatch(/доходят до интерфейса туннеля, но macOS их не принимает/))
  it('server sends packets, none are replies → server side / our data format', () =>
    expect(verdict(HDR + [SYN, SYN, SYN].join('\n'), [OUT(200), OUT(200), IN(92), IN(92)].join('\n'))).toMatch(/сервер присылает пакеты \(2\)/))
  it('server silent after handshake', () =>
    expect(verdict(HDR + SYN, [OUT(200), OUT(200)].join('\n'))).toMatch(/перестал отвечать/))
  it('nothing enters the tunnel', () => expect(verdict(HDR, OUT(200))).toMatch(/не попадают в туннель/))
  it('summarises counts and sizes', () =>
    expect(verdict(HDR + SYN, [OUT(238), OUT(238), IN(92)].join('\n'))).toMatch(/к серверу 2 UDP \(238×2\), от сервера 1 UDP \(92\)/))
  it('summarises inner traffic', () =>
    expect(verdict(HDR + [SYN, SYNACK].join('\n'), '')).toMatch(/TCP: исходящих 1 \(SYN 1\), входящих 1 \(SYN-ACK 1\)/))
  it('reports capture failures', () =>
    expect(verdict('tcpdump: utun4: No such device exists', 'tcpdump: en0: permission denied')).toBe(
      'warn: Захват в туннеле не удался: utun4: No such device exists\nwarn: Захват на Wi-Fi не удался: en0: permission denied'
    ))
})
