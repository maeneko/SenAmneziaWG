import type { LogLevel } from '../../shared/types'

export interface InnerCapture {
  synOut: number
  synAckIn: number
  packets: number
  tcpOut: number
  tcpIn: number
  udpOut: number
  udpIn: number
  /** Packets tcpdump -vv flags as "cksum … (incorrect -> …)". */
  badChecksum: number
}

export interface OuterCapture {
  out: number
  in: number
  inSizes: number[]
  outSizes: number[]
}

/** tcpdump's own failure lines ("tcpdump: …: No such device", permission errors). */
export function captureError(text: string): string | null {
  const line = text.split('\n').find((l) => /^tcpdump: /.test(l) && !/verbose output suppressed|listening on/.test(l))
  return line ? line.replace(/^tcpdump:\s*/, '') : null
}

/**
 * Inside the tunnel (`tcpdump -r -nn` text): every TCP handshake and the traffic split by direction.
 * `localIp` is the tunnel address; `verbose` is optional `-vv` output used only to count bad checksums.
 */
export function parseInnerCapture(text: string, localIp: string, verbose = ''): InnerCapture {
  const res: InnerCapture = { synOut: 0, synAckIn: 0, packets: 0, tcpOut: 0, tcpIn: 0, udpOut: 0, udpIn: 0, badChecksum: 0 }
  const fromUs = new RegExp(`IP6? ${localIp.replaceAll('.', '\\.')}\\.\\d+ > `)
  for (const line of text.split('\n')) {
    if (!/ IP6? \S+ > \S+: /.test(line)) continue
    res.packets++
    const out = fromUs.test(line)
    if (/: Flags \[/.test(line)) {
      if (out) res.tcpOut++
      else res.tcpIn++
      if (out && /Flags \[S\]/.test(line)) res.synOut++
      if (!out && /Flags \[S\.\]/.test(line)) res.synAckIn++
    } else if (!/ICMP/.test(line)) {
      // tcpdump decodes some UDP (DNS, QUIC) and then never prints "UDP" — anything not TCP/ICMP is UDP.
      if (out) res.udpOut++
      else res.udpIn++
    }
  }
  res.badChecksum = (verbose.match(/incorrect ->/g) ?? []).length
  return res
}

/** Outside (Wi-Fi): UDP datagrams to and from the server, with their sizes. */
export function parseOuterCapture(text: string, endpointIp: string): OuterCapture {
  const res: OuterCapture = { out: 0, in: 0, inSizes: [], outSizes: [] }
  for (const line of text.split('\n')) {
    const m = / IP6? (\S+) > (\S+?): UDP, length (\d+)/.exec(line)
    if (!m) continue
    const size = Number(m[3])
    if (m[1].startsWith(`${endpointIp}.`)) {
      res.in++
      res.inSizes.push(size)
    } else if (m[2].startsWith(`${endpointIp}.`)) {
      res.out++
      res.outSizes.push(size)
    }
  }
  return res
}

const sizes = (list: number[]): string => {
  const counts = new Map<number, number>()
  for (const s of list) counts.set(s, (counts.get(s) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([s, n]) => (n > 1 ? `${s}×${n}` : `${s}`)).join(', ') || '—'
}

/** Journal lines naming where packets get lost. */
export function describeCapture(
  innerText: string,
  outerText: string,
  endpointIp: string,
  iface: string,
  localIp = '',
  innerVerbose = ''
): { level: LogLevel; message: string }[] {
  const out: { level: LogLevel; message: string }[] = []
  const innerErr = captureError(innerText)
  const outerErr = captureError(outerText)
  if (innerErr) out.push({ level: 'warn', message: `Захват в туннеле не удался: ${innerErr}` })
  if (outerErr) out.push({ level: 'warn', message: `Захват на Wi-Fi не удался: ${outerErr}` })
  if (innerErr && outerErr) return out

  const inner = parseInnerCapture(innerText, localIp, innerVerbose)
  const outer = parseOuterCapture(outerText, endpointIp)
  out.push({
    level: 'info',
    message:
      `Захват пакетов: в туннеле ${iface} — TCP: исходящих ${inner.tcpOut} (SYN ${inner.synOut}), входящих ${inner.tcpIn} ` +
      `(SYN-ACK ${inner.synAckIn}); UDP: исходящих ${inner.udpOut}, входящих ${inner.udpIn}; неверных контрольных сумм ` +
      `${inner.badChecksum}. Снаружи — к серверу ${outer.out} UDP (${sizes(outer.outSizes)}), от сервера ${outer.in} UDP ` +
      `(${sizes(outer.inSizes)})`
  })

  let verdict: { level: LogLevel; message: string }
  if (!innerErr && inner.badChecksum > 0 && inner.synAckIn === 0) {
    verdict = {
      level: 'error',
      message:
        `Вывод: macOS отдаёт в туннель пакеты с неверной контрольной суммой (${inner.badChecksum}) — ` +
        'адресаты их отбрасывают, поэтому соединения не устанавливаются'
    }
  } else if (!innerErr && inner.synOut === 0) {
    verdict = { level: 'error', message: 'Вывод: TCP-запросы не попадают в туннель — маршруты на этом Mac ведут мимо него' }
  } else if (!innerErr && inner.synAckIn > 0) {
    verdict = {
      level: 'error',
      message:
        'Вывод: ответы сервера доходят до интерфейса туннеля, но macOS их не принимает — ' +
        'мешает фаервол/фильтр трафика или адрес интерфейса'
    }
  } else if (!outerErr && outer.out > 0 && outer.in === 0) {
    verdict = { level: 'error', message: 'Вывод: сервер вообще перестал отвечать после рукопожатия' }
  } else if (!outerErr && outer.in > 0) {
    verdict = {
      level: 'error',
      message:
        `Вывод: сервер присылает пакеты (${outer.in}), но ни один не превращается в ответ на наши запросы — ` +
        'сервер не понимает наши пакеты данных или не выпускает трафик этого клиента'
    }
  } else {
    verdict = { level: 'warn', message: 'Вывод: данных захвата недостаточно для вывода' }
  }
  out.push(verdict)
  return out
}
