// Golden cases for the Android port: the desktop code is the reference, so every expectation here is
// whatever it produces. scripts/dump-golden.mjs bundles this file and writes the result as JSON.
import { encodeVpnLink } from '../../src/main/config/vpnLink'
import { parseVpnLink, parseWgConfig } from '../../src/main/config/wgConfig'
import { base64ToHex } from '../../src/main/config/keys'
import { buildUapiSet, splitEndpoint } from '../../src/main/tunnel/uapiConfig'
import { parseStats } from '../../src/main/tunnel/uapi'
import { isHandshakeFresh } from '../../src/main/tunnel/handshake'
import { best, buildQuery, pingTargets } from '../../src/main/tunnel/ping'
import { redact } from '../../src/main/logger'
import { detectAwgVersion } from '../../src/shared/awgVersion'
import crypto from 'node:crypto'
import { crc32 } from 'node:zlib'
import { decodeSenLink, privateKeyFromSeed, requestSigString, verifyResponse } from '../../src/main/config/senLink'
import { configToParsed, parseSenConfig } from '../../src/main/sen/config'
import { accountName, hasAccessToken } from '../../src/shared/account'
import { normalizeDomain, parseIpOrCidr } from '../../src/shared/netNames'
import {
  ROUTING_DEFAULTS,
  inertRouting,
  listsFromSimple,
  parseRouting,
  parseRoutingLine,
  parseSites,
  resolveRouting,
  routingKey,
  routingSummary,
  rulesFromLists,
  sanitizeRouting,
  unsupportedRules,
  type RoutingSettings
} from '../../src/shared/routingRules'

const KEY = (n: number): string => Buffer.alloc(32, n).toString('base64')

const ini = (extraIface: string[] = [], extraPeer: string[] = []): string =>
  [
    '[Interface]',
    'Address = 10.8.1.2/32',
    'DNS = $PRIMARY_DNS, $SECONDARY_DNS',
    `PrivateKey = ${KEY(1)}`,
    ...extraIface,
    '',
    '[Peer]',
    `PublicKey = ${KEY(2)}`,
    'AllowedIPs = 0.0.0.0/0, ::/0',
    'Endpoint = 203.0.113.7:51820',
    ...extraPeer
  ].join('\n') + '\n'

const LEGACY = ['Jc = 4', 'Jmin = 10', 'Jmax = 50', 'S1 = 60', 'S2 = 100', 'H1 = 1234567', 'H2 = 2345678', 'H3 = 3456789', 'H4 = 4567890']
const V20 = ['Jc = 5', 'Jmin = 8', 'Jmax = 80', 'S1 = 30', 'S2 = 40', 'S3 = 20', 'S4 = 10', 'H1 = 100-200', 'H2 = 300-400', 'H3 = 500-600', 'H4 = 700-800']
const V15 = [...LEGACY, 'I1 = <b 0xf6ab3267fa><c><t><r 10>', 'I2 = <b 0x1234>', 'I3 =', 'I4 =', 'I5 =']
const V30 = [...V20, `HeaderProtectionKey = ${KEY(9)}`, 'ContentPaddingAddition = 16', 'RekeyAfterTime = 120', 'RekeyTimeout = 5', 'RejectAfterTime = 180', 'KeepaliveTimeout = 10', 'MaxHandshakeAttempts = 20']
const V31 = [...V30, 'RandomTrailers = on', 'DisableCookies = off']
const V31_OFF = [...V20, 'RandomTrailers = off', 'DisableCookies = off']

const link = (config: string, root: Record<string, unknown> = {}, last: Record<string, unknown> = {}): string =>
  encodeVpnLink({
    hostName: '203.0.113.7',
    description: 'My server',
    dns1: '1.1.1.1',
    dns2: '1.0.0.1',
    defaultContainer: 'amnezia-awg',
    containers: [
      { container: 'amnezia-xray', xray: { last_config: '{}' } },
      { container: 'amnezia-awg', awg: { last_config: JSON.stringify({ config, mtu: '1280', ...last }) } }
    ],
    ...root
  })

const confs: Record<string, string> = {
  wireguard: ini(),
  noDns: ini().replace('DNS = $PRIMARY_DNS, $SECONDARY_DNS\n', ''),
  wireguardPsk: ini([], [`PresharedKey = ${KEY(3)}`, 'PersistentKeepalive = 25']),
  legacy: ini(LEGACY, ['PersistentKeepalive = 25']),
  v15: ini(V15),
  v20: ini(V20),
  v30: ini(V30, [`PresharedKey = ${KEY(3)}`]),
  v31: ini(V31),
  v31Off: ini(V31_OFF),
  snakeCase: ini(['jc = 3', 'header_protection_key = ' + KEY(9), 'random_trailers = 1']),
  mtuInConf: ini(['MTU = 1380', ...LEGACY]),
  commentsAndCrlf: ini(['# comment', '; other', ...LEGACY]).replaceAll('\n', '\r\n'),
  v6Endpoint: ini(LEGACY).replace('203.0.113.7:51820', '[2001:db8::1]:51820'),
  hostnameEndpoint: ini().replace('203.0.113.7:51820', 'vpn.example.com:443'),
  noAllowedIps: ini().replace('AllowedIPs = 0.0.0.0/0, ::/0\n', ''),
  noInterface: '[Peer]\nPublicKey = x\n',
  noPrivateKey: ini().replace(`PrivateKey = ${KEY(1)}\n`, ''),
  noEndpoint: ini().replace('Endpoint = 203.0.113.7:51820\n', ''),
  noAddress: ini().replace('Address = 10.8.1.2/32\n', ''),
  shortKey: ini().replace(KEY(1), 'AAAA'),
  badHeaderProtectionKey: ini(['HeaderProtectionKey = AAAA'])
}

// The $…_DNS placeholders are Amnezia's: only a vpn:// link resolves them, a plain .conf carries addresses.
for (const k of Object.keys(confs)) confs[k] = confs[k].replaceAll('$PRIMARY_DNS', '1.1.1.1').replaceAll('$SECONDARY_DNS', '1.0.0.1')

const links: Record<string, { input: string; name?: string }> = {
  legacy: { input: link(ini(LEGACY, ['PersistentKeepalive = 25'])) },
  v20: { input: link(ini(V20)) },
  v31: { input: link(ini(V31)) },
  nameOverride: { input: link(ini(LEGACY)), name: '  Custom  ' },
  noDescription: { input: link(ini(LEGACY), { description: '' }) },
  noNames: { input: link(ini(LEGACY), { description: '', hostName: '' }) },
  noMtu: { input: encodeVpnLink({ containers: [{ container: 'amnezia-awg', awg: { last_config: JSON.stringify({ config: ini(LEGACY) }) } }], defaultContainer: 'amnezia-awg', dns1: '9.9.9.9', dns2: '' }) },
  numericMtu: { input: link(ini(LEGACY), {}, { mtu: 1420 }) },
  noAwgContainer: { input: encodeVpnLink({ containers: [{ container: 'amnezia-xray', xray: { last_config: '{}' } }] }) },
  noContainers: { input: encodeVpnLink({ containers: [] }) },
  emptyConfig: { input: link('') },
  brokenLastConfig: { input: encodeVpnLink({ containers: [{ container: 'amnezia-awg', awg: { last_config: '{not json' } }] }) },
  wrongPrefix: { input: 'not-a-link' },
  emptyPayload: { input: 'vpn://' },
  badChars: { input: 'vpn://!!!' },
  notAmnezia: { input: 'vpn://aGVsbG8' },
  upperPrefixAndSpaces: { input: '  VPN://' + link(ini(LEGACY)).slice(6).replace(/(.{20})/g, '$1\n') + ' ' },
  stdBase64: { input: 'vpn://' + Buffer.from(link(ini(LEGACY)).slice(6), 'base64url').toString('base64') },
  plainJson: { input: 'vpn://' + Buffer.from(JSON.stringify({ containers: [{ container: 'awg', x: { last_config: JSON.stringify({ config: ini(LEGACY) }) } }] })).toString('base64url') }
}

type Outcome<T> = { ok: T } | { error: string }
const run = <T>(fn: () => T): Outcome<T> => {
  try {
    return { ok: fn() }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}
const scrub = (p: { tunnel: { id: string } }): unknown => ({ ...p, tunnel: { ...p.tunnel, id: '' } })

const stats = [
  'private_key=aa\nlisten_port=0\npublic_key=bb\nendpoint=203.0.113.7:51820\nlast_handshake_time_sec=1700000000\nlast_handshake_time_nsec=5\ntx_bytes=1234\nrx_bytes=5678\npersistent_keepalive_interval=25\nallowed_ip=0.0.0.0/0\nerrno=0\n\n',
  'private_key=aa\npublic_key=bb\nerrno=0\n\n',
  'errno=0\n\n',
  'public_key=a\nrx_bytes=1\ntx_bytes=2\nlast_handshake_time_sec=0\npublic_key=b\nrx_bytes=99\n'
]

// ── sen:// ─────────────────────────────────────────────────────────────────

const SEN_SEED = Buffer.alloc(32, 5)
const senPub = (seed: Buffer): Buffer =>
  (crypto.createPublicKey(privateKeyFromSeed(seed)).export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32)
const SEN_SIGN_PUB = senPub(SEN_SEED)
const port = (p: number): Buffer => Buffer.from([p >> 8, p & 255])
const v4 = (a: number[], p: number): Buffer => Buffer.concat([Buffer.from([0x04, ...a]), port(p)])
const v6 = (groups: number[], p: number): Buffer => {
  const b = Buffer.alloc(16)
  groups.forEach((g, i) => b.writeUInt16BE(g, i * 2))
  return Buffer.concat([Buffer.from([0x06]), b, port(p)])
}
const dom = (d: string, p: number): Buffer => Buffer.concat([Buffer.from([0x44, d.length]), Buffer.from(d), port(p)])

interface SenParts {
  version?: number
  flags?: number
  addrs?: Buffer[]
  count?: number
  secret?: Buffer
  signPub?: Buffer
  pin?: Buffer
  name?: string | Buffer
  trailing?: Buffer
}
function senBody(o: SenParts): Buffer {
  const addrs = o.addrs ?? [v4([203, 0, 113, 7], 40123)]
  const name = typeof o.name === 'string' ? Buffer.from(o.name) : (o.name ?? Buffer.from('Семья'))
  return Buffer.concat([
    Buffer.from([o.version ?? 1, o.flags ?? 0, o.count ?? addrs.length]),
    ...addrs,
    o.secret ?? Buffer.alloc(16, 0x11),
    o.signPub ?? SEN_SIGN_PUB,
    ...(o.pin ? [o.pin] : []),
    Buffer.from([name.length]),
    name,
    o.trailing ?? Buffer.alloc(0)
  ])
}
const withCrc = (body: Buffer, bad = false): string => {
  const c = Buffer.alloc(4)
  c.writeUInt32BE((crc32(body) ^ (bad ? 1 : 0)) >>> 0)
  return 'sen://' + Buffer.concat([body, c]).toString('base64url')
}
const PIN = Buffer.alloc(32, 0x33)
const senLinks: Record<string, string> = {
  plain: withCrc(senBody({})),
  tls: withCrc(senBody({ flags: 1, pin: PIN })),
  threeAddrs: withCrc(senBody({ addrs: [v4([203, 0, 113, 7], 40123), v6([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1], 443), dom('keys.example.com', 8443)] })),
  v6Folding: withCrc(senBody({ addrs: [v6([0, 0, 0, 0, 0, 0, 0, 1], 1), v6([0x2001, 0, 0, 1, 0, 0, 0, 2], 2), v6([1, 2, 3, 4, 5, 6, 7, 8], 3)] })),
  emptyName: withCrc(senBody({ name: '' })),
  longestName: withCrc(senBody({ name: 'x'.repeat(64) })),
  withLogin: withCrc(senBody({})) + '#ma7_3f9a1c',
  withToken: withCrc(senBody({})) + '#ma7_3f9a1c.7K3MQX9P2HWDR4TN',
  emptyLogin: withCrc(senBody({})) + '#',
  spacedAndUpper: '  SEN://' + withCrc(senBody({})).slice(6).replace(/(.{16})/g, '$1\n') + '  ',
  badLoginChars: withCrc(senBody({})) + '#bad login!',
  badCrc: withCrc(senBody({}), true),
  noPrefix: 'vpn://AAAA',
  badChars: 'sen://!!!!',
  tooShort: 'sen://AAAA',
  unknownVersion: withCrc(senBody({ version: 2 })),
  unknownFlags: withCrc(senBody({ flags: 2 })),
  zeroAddrs: withCrc(senBody({ addrs: [], count: 0 })),
  fourAddrs: withCrc(senBody({ addrs: [v4([1, 1, 1, 1], 1), v4([1, 1, 1, 2], 2), v4([1, 1, 1, 3], 3), v4([1, 1, 1, 4], 4)] })),
  portZero: withCrc(senBody({ addrs: [v4([1, 1, 1, 1], 0)] })),
  emptyDomain: withCrc(senBody({ addrs: [Buffer.from([0x44, 0, 0, 80])] })),
  badDomain: withCrc(senBody({ addrs: [dom('bad domain!', 80)] })),
  unknownAddrType: withCrc(senBody({ addrs: [Buffer.from([0x05, 1, 2, 3, 4, 0, 80])] })),
  trailingBytes: withCrc(senBody({ trailing: Buffer.from([1]) })),
  truncated: withCrc(senBody({}).subarray(0, 30)),
  nameTooLong: withCrc(senBody({ name: Buffer.alloc(65, 0x78) }))
}

const hexed = (l: ReturnType<typeof decodeSenLink>): unknown => ({
  tls: l.tls,
  addrs: l.addrs,
  secret: l.secret.toString('hex'),
  signPub: l.signPub.toString('hex'),
  tlsPin: l.tlsPin?.toString('hex') ?? null,
  name: l.name,
  login: l.login ?? null
})

const SERVER = {
  id: 0,
  name: 'VPN',
  endpoint: '203.0.113.7:47619',
  server_pub: KEY(2),
  psk: KEY(4),
  address: '10.9.0.5/32',
  dns: ['1.1.1.1', '1.0.0.1'],
  keepalive: '25',
  mtu: 1376,
  gen: '3.1',
  awg: { Jc: '4', Jmin: '40', Jmax: '70', S1: '0', S2: '0', H1: '1', H2: '2', H3: '3', H4: '4', I1: '<b 0xf6ab>' }
}
const senConfigs: Record<string, unknown> = {
  one: { rev: 'abc', rekey: false, endpoints: ['203.0.113.7:40123'], servers: [SERVER] },
  two: { rev: 'def', rekey: true, endpoints: ['a:1', 'bad endpoint', 'b:2', '[2001:db8::1]:3', 'noport'], servers: [SERVER, { ...SERVER, id: 3, name: 'DE', psk: '', keepalive: '', mtu: undefined, awg: { Jc: '3', S1: '' } }] },
  defaults: { rev: 'x', servers: [{ endpoint: 'h:1', server_pub: KEY(2), address: '10.0.0.2/32', id: 'seven' }] },
  noRev: { servers: [SERVER] },
  emptyRev: { rev: '', servers: [SERVER] },
  noServers: { rev: 'a' },
  notObject: 'nope',
  nullConfig: null,
  duplicateIds: { rev: 'a', servers: [SERVER, SERVER] },
  newlineInName: { rev: 'a', servers: [{ ...SERVER, name: 'a\nb' }] },
  newlineInEndpoint: { rev: 'a', servers: [{ ...SERVER, endpoint: 'h:1\nPostUp = x' }] },
  missingAddress: { rev: 'a', servers: [{ ...SERVER, address: undefined }] },
  badAwgKey: { rev: 'a', servers: [{ ...SERVER, awg: { 'bad key': '1' } }] },
  badAwgValue: { rev: 'a', servers: [{ ...SERVER, awg: { Jc: 4 } }] },
  awgNotObject: { rev: 'a', servers: [{ ...SERVER, awg: [] }] },
  badDnsDropped: { rev: 'a', servers: [{ ...SERVER, dns: ['1.1.1.1', '', 5, 'a\nb'] }] },
  zeroMtu: { rev: 'a', servers: [{ ...SERVER, mtu: 0 }] },
  serverNotObject: { rev: 'a', servers: [1] }
}

const SEN_TS = 1700000000
const sigCases = [
  { method: 'GET', path: '/sub/v1/config', ts: SEN_TS, body: '' },
  { method: 'post', path: '/sub/v1/rekey', ts: SEN_TS + 1, body: '{"pub_key":"abc"}' },
  { method: 'DELETE', path: '/sub/v1/device', ts: SEN_TS + 2, body: '' },
  { method: 'POST', path: '/sub/v1/register', ts: SEN_TS + 3, body: '{"имя":"Семья"}' }
]
const signText = (text: string, seed = SEN_SEED): string => crypto.sign(null, Buffer.from(text, 'utf8'), privateKeyFromSeed(seed)).toString('base64url')
const envelope = (body: string, seed = SEN_SEED): { body: unknown; sig: unknown } => ({ body, sig: signText(body, seed) })
const respBody = JSON.stringify({ ts: SEN_TS, device: 7, config: { rev: 'abc' } })
const respCases: Record<string, { body: unknown; sig: unknown }> = {
  valid: envelope(respBody),
  validUnicode: envelope('{"name":"Семья"}'),
  tampered: { ...envelope(respBody), body: respBody.replace('abc', 'abd') },
  otherKey: envelope(respBody, Buffer.alloc(32, 6)),
  sigNotString: { body: respBody, sig: 5 },
  bodyNotString: { body: { a: 1 }, sig: signText('x') },
  sigGarbage: { body: respBody, sig: '!!!' },
  sigShort: { body: respBody, sig: 'AAAA' }
}

function buildSenGolden(): unknown {
  const privateKey = KEY(3)
  return {
    seedHex: SEN_SEED.toString('hex'),
    signPubHex: SEN_SIGN_PUB.toString('hex'),
    links: Object.fromEntries(Object.entries(senLinks).map(([k, input]) => [k, { input, result: run(() => hexed(decodeSenLink(input))) }])),
    configs: Object.fromEntries(
      Object.entries(senConfigs).map(([k, input]) => {
        const parsed = run(() => parseSenConfig(JSON.parse(JSON.stringify(input ?? null))))
        const tunnels = 'ok' in parsed ? parsed.ok.servers.map((s) => run(() => scrub(configToParsed(s, privateKey, `Key · ${s.name}`)))) : []
        return [k, { input: JSON.parse(JSON.stringify(input ?? null)), result: parsed, tunnels }]
      })
    ),
    signatures: sigCases.map((c) => {
      const message = requestSigString(c.method, c.path, c.ts, c.body)
      return { ...c, message, sig: signText(message) }
    }),
    responses: Object.fromEntries(
      Object.entries(respCases).map(([k, r]) => [k, { body: r.body, sig: r.sig, valid: verifyResponse(r, SEN_SIGN_PUB) }])
    ),
    accounts: ['ma7_3f9a1c', 'ma7_3f9a1c.7K3MQX9P2HWDR4TN', '.x', 'a.b.c', ''].map((l) => ({ login: l, name: accountName(l), token: hasAccessToken(l) }))
  }
}

const R = (patch: Partial<RoutingSettings>): RoutingSettings => ({ ...ROUTING_DEFAULTS, ...patch })

function buildRoutingGolden(): unknown {
  const lines = [
    '', '   ', '# comment', 'example.com', 'EXAMPLE.com', '*.example.com', 'suffix:Example.COM', 'domain:www.example.com', 'keyword:adservice', 'keyword:a',
    'regex:\\.(ru|su)$', 'regex:(?=a)b', 'regex:a\\1', 'regex:(', 'ip:10.0.0.0/8', 'ip:10.0.0.0/7', '8.8.8.8', '1.1.1.0/24', 'ip:2001:db8::/32', 'ip:2001:db8::/15',
    '2001:db8::/32', 'ip:::1', 'ip:300.1.1.1', 'processName:spotify', 'processName:a/b', 'processPath:/usr/bin/spotify', 'processPath:rel/path',
    'ruleset:geoip-ru', 'ruleset:https://example.com/x.srs', 'ruleset:bad', 'nope:abc', 'com', 'bücher.de', 'https://example.com', 'a.b', 'xn--p1ai.xn--p1ai'
  ]
  const sites = ['example.com', 'a.com, b.com;c.com d.com', 'https://user@www.Example.com:8443/path?q=1', '# c\nx.org\n\nx.org', 'suffix:example.com', 'localhost', '1.2.3.4', '*.k.io', 'ünï.рф']
  const domains = ['example.com', ' Example.COM. ', '*.example.com', 'a', 'a..b', '-a.com', 'a-.com', 'a.com-', '1.2.3.4', 'a.1', 'bücher.de', 'рф.рф', 'x'.repeat(64) + '.com', 'a b.com', 'a_b.com', '']
  const nets = ['10.0.0.0/8', '10.0.0.0/7', '10.0.0.1', '2001:DB8::/32', '2001:db8::/15', '::1', '1.2.3.4/33', '1.2.3.4/x', '1.2.3.4/', 'abc', '256.1.1.1', 'fe80::1%eth0', '192.168.0.0/16 ']
  const settings: Record<string, RoutingSettings> = {
    defaults: ROUTING_DEFAULTS,
    simpleExcept: R({ simple: { kind: 'except', sites: 'ozon.ru\nhttps://www.ozone.ru/x' } }),
    simpleOnly: R({ simple: { kind: 'only', sites: 'youtube.com, googlevideo.com' } }),
    simpleBlock: R({ simple: { kind: 'block', sites: 'doubleclick.net' } }),
    simpleEmpty: R({ simple: { kind: 'only', sites: '' } }),
    lists: R({ mode: 'lists', final: 'direct', name: 'Мой набор', proxy: 'suffix:youtube.com\ndomain:nura.eco\nsuffix:youtube.com', direct: 'regex:\\.(ru|su)$', block: 'keyword:adservice' }),
    listsInert: R({ mode: 'lists', final: 'proxy', proxy: 'suffix:a.com' }),
    listsInertDirect: R({ mode: 'lists', final: 'direct', direct: 'suffix:a.com' }),
    apps: R({ mode: 'lists', final: 'direct', proxy: 'processName:org.telegram.messenger\nprocessPath:/x/y\nruleset:geoip-ru\nip:203.0.113.0/24' }),
    onlyApps: R({ mode: 'lists', final: 'proxy', proxy: 'processName:a.b' }),
    rules: R({
      mode: 'rules',
      final: 'direct',
      rules: [
        { name: 'A', action: 'block', lines: 'suffix:ads.example.com', enabled: true },
        { name: 'B', action: 'proxy', lines: 'suffix:example.com\nip:10.1.0.0/16', enabled: true },
        { name: 'C', action: 'direct', lines: 'suffix:off.example.com', enabled: false }
      ]
    })
  }
  const sanitizeInputs: unknown[] = [
    null, 5, {}, { final: 'proxy' }, { final: 'x', proxy: '', direct: '', block: '' },
    { final: 'proxy', proxy: '', direct: '', block: '' },
    { final: 'direct', proxy: 'suffix:a.com', direct: '', block: '', name: '  Имя\u0001x ', mode: 'lists' },
    { final: 'direct', proxy: 'bad:line', direct: '', block: '' },
    { final: 'direct', proxy: '', direct: '', block: '', mode: 'rules', rules: [{ action: 'proxy', lines: 'a.com', name: '', enabled: false }] },
    { final: 'direct', proxy: '', direct: '', block: '', rules: [{ action: 'x', lines: '' }] },
    { final: 'direct', proxy: '', direct: '', block: '', simple: { kind: 'only', sites: 'a.com' } },
    { final: 'direct', proxy: '', direct: '', block: '', simple: { kind: 'zzz', sites: 'a.com' } },
    { final: 'direct', proxy: '', direct: '', block: '', simple: { kind: 'only', sites: 'ip:1.2.3.4' } }
  ]
  return {
    lines: lines.map((l) => ({ input: l, result: parseRoutingLine(l) })),
    sites: sites.map((t) => ({ input: t, result: parseSites(t) })),
    domains: domains.map((d) => ({ input: d, result: normalizeDomain(d) })),
    nets: nets.map((n) => ({ input: n, result: parseIpOrCidr(n) })),
    settings: Object.fromEntries(
      Object.entries(settings).map(([k, v]) => {
        const caps = { process: true, ruleset: false }
        const config = resolveRouting(v, caps)
        return [k, {
          input: v,
          parsed: parseRouting(v),
          resolved: config,
          unsupported: unsupportedRules(parseRouting(v).rules, caps),
          inert: inertRouting(config),
          summary: routingSummary(v, caps),
          key: routingKey(v),
          rulesFromLists: rulesFromLists(v),
          listsFromSimple: listsFromSimple(v)
        }]
      })
    ),
    sanitize: sanitizeInputs.map((i) => ({ input: i, result: sanitizeRouting(i) }))
  }
}

export function buildGolden(): unknown {
  const parsedConfs = Object.fromEntries(
    Object.entries(confs).map(([k, text]) => [k, { input: text, name: 'Conf', result: run(() => scrub(parseWgConfig(text, { name: 'Conf', dns: ['8.8.8.8'] }))) }])
  )
  const parsedLinks = Object.fromEntries(
    Object.entries(links).map(([k, v]) => [k, { ...v, result: run(() => scrub(parseVpnLink(v.input, v.name))) }])
  )

  // UAPI bodies and versions for every conf that parses.
  const uapi: Record<string, unknown> = {}
  for (const [k, text] of Object.entries(confs)) {
    const r = run(() => parseWgConfig(text, { name: 'Conf' }))
    if ('error' in r) continue
    const { tunnel, secrets } = r.ok
    const host = tunnel.endpoint.startsWith('[') ? '2001:db8::1' : '203.0.113.7'
    uapi[k] = { endpointIp: host, body: buildUapiSet(tunnel, secrets, host), version: detectAwgVersion(tunnel.awg) }
  }

  return {
    sen: buildSenGolden(),
    routing: buildRoutingGolden(),
    confs: parsedConfs,
    links: parsedLinks,
    uapi,
    stats: stats.map((s) => ({ input: s, result: parseStats(s) })),
    handshake: [0, 1700000000 - 10, 1700000000 - 179, 1700000000 - 180, 1700000000 - 1000].map((sec) => ({
      lastHandshakeSec: sec,
      nowSec: 1700000000,
      fresh: isHandshakeFresh({ rxBytes: 0, txBytes: 0, lastHandshakeSec: sec }, 1700000000)
    })),
    endpoints: ['203.0.113.7:51820', '[2001:db8::1]:51820', 'vpn.example.com:443', 'no-port'].map((e) => ({ input: e, result: run(() => splitEndpoint(e)) })),
    keys: [KEY(1), KEY(1) + ' ', 'AAAA', ''].map((k) => ({ input: k, result: run(() => base64ToHex(k)) })),
    redact: [
      `key ${KEY(1)} here`,
      `hex ${Buffer.alloc(32, 7).toString('hex')} here`,
      'link sen://AbCd_-123#ma7_a1b2c3.abcdefghijklmnop end',
      'login ma7_a1b2c3 and ma7_a1b2c3.0123456789abcdef',
      'nothing secret: handshake 1234'
    ].map((s) => ({ input: s, result: redact(s) })),
    ping: {
      query: [...buildQuery(0x1234, 'abcd1234')],
      targets: [[], ['10.0.0.1'], ['fd00::1'], ['fd00::1', '10.0.0.2']].map((d) => ({ dns: d, result: pingTargets(d) })),
      best: [[null, null], [12.4, null, 30], [7.5], []].map((s) => ({ samples: s, result: best(s) }))
    }
  }
}
