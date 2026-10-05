import crypto from 'node:crypto'
import type { UpdateOs } from './server'

/**
 * Who may publish an update: Ed25519 public keys, raw 32 bytes in base64. The private half is the CI
 * secret UPDATE_SIGNING_KEY (docs/ci.md), never the update server's: a server that is broken into can
 * serve any file, but cannot sign one. More than one, so that a new key can be shipped before the old
 * one is retired; scripts/sign-update.mjs refuses to sign with a key that is not here.
 */
export const UPDATE_KEYS: readonly string[] = ['q7qNUi4SWU95GF52Vw3n2bJAMlCXQToLD0aP37fGcQs=']

/**
 * What is signed for one installer — scripts/sign-update.mjs writes the same lines, so a change here is
 * a change there. The name carries the version, so a signature cannot be moved to another version of
 * the file, nor the file to another system.
 */
export function updateMessage(os: UpdateOs, name: string, size: number, sha256: string): string {
  return ['senawg-update-v1', os, name, String(size), sha256].join('\n')
}

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/** Whether `sig` (base64 of 64 bytes) signs `message` with one of `keys`. */
export function verifyUpdate(message: string, sig: string, keys: readonly string[] = UPDATE_KEYS): boolean {
  const signature = Buffer.from(sig.trim(), 'base64')
  if (signature.length !== 64) return false
  return keys.some((k) => {
    try {
      const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(k, 'base64')]), format: 'der', type: 'spki' })
      return crypto.verify(null, Buffer.from(message, 'utf8'), key, signature)
    } catch {
      return false
    }
  })
}
