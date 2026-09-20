import { deflateSync, inflateSync } from 'node:zlib'

export class VpnLinkError extends Error {}

const PREFIX = 'vpn://'

/** vpn://<base64url(qCompress(json))>, qCompress = 4-byte big-endian length + zlib stream. */
export function decodeVpnLink(link: string): Record<string, unknown> {
  const trimmed = link.trim()
  if (!trimmed.toLowerCase().startsWith(PREFIX)) {
    throw new VpnLinkError('Ссылка должна начинаться с vpn://')
  }
  const payload = trimmed.slice(PREFIX.length).replace(/\s+/g, '')
  if (!payload) throw new VpnLinkError('В ссылке нет данных после vpn://')
  if (!/^[A-Za-z0-9_\-+/=]+$/.test(payload)) {
    throw new VpnLinkError('Ссылка повреждена: недопустимые символы')
  }

  const raw = Buffer.from(payload.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), 'base64url')

  let json: string
  try {
    if (raw.length < 5) throw new Error('short')
    const expected = raw.readUInt32BE(0)
    const inflated = inflateSync(raw.subarray(4))
    if (inflated.length !== expected) throw new Error('length mismatch')
    json = inflated.toString('utf8')
  } catch {
    // Fallback: some exports are plain base64 JSON without compression.
    json = raw.toString('utf8')
  }

  try {
    const parsed: unknown = JSON.parse(json)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed as Record<string, unknown>
  } catch {
    throw new VpnLinkError('Не удалось прочитать ссылку: содержимое не похоже на конфиг Amnezia')
  }
}

export function encodeVpnLink(config: Record<string, unknown>): string {
  const json = Buffer.from(JSON.stringify(config), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(json.length, 0)
  return PREFIX + Buffer.concat([header, deflateSync(json)]).toString('base64url')
}
