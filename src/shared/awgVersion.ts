import type { AwgParams } from './types'

export type AwgVersion = 'wireguard' | 'legacy' | '2.0' | '3.0' | '3.1'

/** .conf key (lowercased) → UAPI key, for everything beyond the 1.0 core (jc…h4). */
export const AWG_EXTRA_KEYS: Record<string, string> = {
  // 1.5
  i1: 'i1',
  i2: 'i2',
  i3: 'i3',
  i4: 'i4',
  i5: 'i5',
  // 2.0
  s3: 's3',
  s4: 's4',
  // 3.0
  headerprotectionkey: 'header_protection_key',
  contentpaddingaddition: 'content_padding_addition',
  rekeyaftertime: 'rekey_after_time',
  rekeytimeout: 'rekey_timeout',
  rejectaftertime: 'reject_after_time',
  keepalivetimeout: 'keepalive_timeout',
  maxhandshakeattempts: 'max_handshake_attempts',
  // 3.1
  randomtrailers: 'random_trailers',
  disablecookies: 'disable_cookies'
}

/**
 * UAPI key → the spelling of a `.conf` file (Amnezia's own casing). Inverse of AWG_EXTRA_KEYS, for
 * backends that are configured from a `.conf` instead of a UAPI body.
 */
export const AWG_CONF_KEYS: Record<string, string> = {
  i1: 'I1',
  i2: 'I2',
  i3: 'I3',
  i4: 'I4',
  i5: 'I5',
  s3: 'S3',
  s4: 'S4',
  header_protection_key: 'HeaderProtectionKey',
  content_padding_addition: 'ContentPaddingAddition',
  rekey_after_time: 'RekeyAfterTime',
  rekey_timeout: 'RekeyTimeout',
  reject_after_time: 'RejectAfterTime',
  keepalive_timeout: 'KeepaliveTimeout',
  max_handshake_attempts: 'MaxHandshakeAttempts',
  random_trailers: 'RandomTrailers',
  disable_cookies: 'DisableCookies'
}

/** 3.1 switches. Amnezia writes them as `on`/`off`; only an enabled one needs a 3.1 daemon. */
export const AWG_TOGGLES = ['random_trailers', 'disable_cookies']

/** Same reading as the Amnezia client (`InterfaceConfig::awgBoolToUapi`): anything else is off. */
export function awgToggleOn(value: string | undefined): boolean {
  return ['on', '1', 'true', 't', 'yes'].includes((value ?? '').trim().toLowerCase())
}
const V30 = [
  'header_protection_key',
  'content_padding_addition',
  'rekey_after_time',
  'rekey_timeout',
  'reject_after_time',
  'keepalive_timeout',
  'max_handshake_attempts'
]
const V20 = ['s3', 's4']
const V15 = ['i1', 'i2', 'i3', 'i4', 'i5']

/**
 * Configs carry no version field, so the protocol generation is inferred from which parameters are
 * present: each version only adds keys on top of the previous one. '3.0' vs '3.1' is the daemon a
 * config needs (3.1 only for an enabled RandomTrailers/DisableCookies), not what the user is shown.
 */
export function detectAwgVersion(awg: AwgParams): AwgVersion {
  const has = (keys: string[]): boolean => keys.some((k) => k in awg.extra)
  if (AWG_TOGGLES.some((k) => awgToggleOn(awg.extra[k]))) return '3.1'
  if (has(V30)) return '3.0'
  const headers = [awg.h1, awg.h2, awg.h3, awg.h4]
  if (has(V20) || headers.some((h) => h.includes('-'))) return '2.0'
  const defaultHeaders = headers.every((h, i) => h === String(i + 1))
  if (has(V15) || awg.jc > 0 || awg.s1 > 0 || awg.s2 > 0 || !defaultHeaders) return 'legacy'
  return 'wireguard'
}

/**
 * What the user sees. '3.0' and '3.1' differ only in which daemon can run them (see
 * binaryVersion.ts); Amnezia calls the whole third generation «3.1» (`protocols::awg::awgV3`), so the
 * label does too — otherwise the same key reads «3.0» here and «3.1» in the Amnezia app.
 */
export const AWG_VERSION_LABEL: Record<AwgVersion, string> = {
  wireguard: 'WireGuard',
  legacy: 'Legacy (1.5)',
  '2.0': 'AmneziaWG 2.0',
  '3.0': 'AmneziaWG 3.1',
  '3.1': 'AmneziaWG 3.1'
}
