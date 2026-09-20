import { execFile } from 'node:child_process'
import type { AwgVersion } from '../../shared/awgVersion'

/** Parses `amneziawg-go --version` output: "amneziawg-go v3.1.20260828" or the older "0.0.20250522". */
export function parseBinaryVersion(output: string): { major: number; minor: number; raw: string } | null {
  const m = /amneziawg-go\s+v?(\d+)\.(\d+)\.(\S+)/.exec(output)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), raw: `${m[1]}.${m[2]}.${m[3]}` }
}

/** Oldest daemon that understands each config generation. Pre-3.0 builds are numbered 0.x. */
const REQUIRED: Partial<Record<AwgVersion, [number, number]>> = {
  '3.0': [3, 0],
  '3.1': [3, 1]
}

export function binarySupports(binary: { major: number; minor: number }, config: AwgVersion): boolean {
  const need = REQUIRED[config]
  if (!need) return true
  return binary.major > need[0] || (binary.major === need[0] && binary.minor >= need[1])
}

export function readBinaryVersion(path: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(path, ['--version'], { timeout: 5000 }, (_err, stdout, stderr) => resolve(`${stdout}${stderr}`))
  })
}
