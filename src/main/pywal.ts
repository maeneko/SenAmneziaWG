import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PywalPalette } from '../shared/types'

const HEX = /^#[0-9a-fA-F]{6}$/

/** Where pywal writes the palette of the current wallpaper. */
export const pywalPath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'wal', 'colors.json')

/** The palette from pywal's colors.json; null when it is not there or not a palette. Only #rrggbb gets through. */
export function parsePywal(text: string): PywalPalette | null {
  try {
    const raw = JSON.parse(text) as { special?: Record<string, unknown>; colors?: Record<string, unknown> }
    const colors = Array.from({ length: 16 }, (_, i) => raw.colors?.[`color${i}`])
    const background = raw.special?.background
    const foreground = raw.special?.foreground
    const ok = (v: unknown): v is string => typeof v === 'string' && HEX.test(v)
    if (!ok(background) || !ok(foreground) || !colors.every(ok)) return null
    return { background, foreground, colors }
  } catch {
    return null
  }
}

export function readPywal(): PywalPalette | null {
  try {
    return parsePywal(readFileSync(pywalPath(), 'utf8'))
  } catch {
    return null
  }
}
