/** WireGuard keys are 32 bytes: base64 in .conf / Amnezia JSON, lowercase hex in UAPI. */
export function base64ToHex(key: string): string {
  const buf = Buffer.from(key.trim(), 'base64')
  if (buf.length !== 32) throw new Error('Ключ должен быть 32 байта в base64')
  return buf.toString('hex')
}

export function hexToBase64(hex: string): string {
  const buf = Buffer.from(hex, 'hex')
  if (buf.length !== 32) throw new Error('Ключ должен быть 32 байта в hex')
  return buf.toString('base64')
}
