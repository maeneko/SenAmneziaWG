import type { PywalPalette } from '@shared/types'

const mix = (a: string, b: string, pct: number): string => `color-mix(in srgb, ${a} ${pct}%, ${b})`

function hsl(hex: string): { s: number; l: number } {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  return { l, s: d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)) }
}

const luminance = (hex: string): number => hsl(hex).l

/** The most colourful of color1–color6 that is neither near-black nor near-white; color4 when none is. */
export function pickAccent(p: PywalPalette): string {
  const usable = p.colors.slice(1, 7).filter((c) => hsl(c).l > 0.3 && hsl(c).l < 0.85)
  return usable.sort((a, b) => hsl(b).s - hsl(a).s)[0] ?? p.colors[4]
}

/** The design tokens (tokens.css) re-derived from a palette: surfaces from background/foreground, accent from the palette. */
export function pywalTokens(p: PywalPalette): Record<string, string> {
  const { background: bg, foreground: fg } = p
  const accent = pickAccent(p)
  const dark = luminance(bg) < 0.5
  // On a dark surface the accent is lifted towards the text colour, on a light one sunk towards the background.
  const primary = dark ? mix(accent, fg, 80) : mix(accent, bg, 75)
  return {
    '--primary': primary,
    '--on-primary': bg,
    '--primary-container': mix(accent, bg, 30),
    '--on-primary-container': mix(accent, fg, 35),
    '--secondary-container': mix(p.colors[5], bg, 20),
    '--on-secondary-container': fg,
    '--tertiary-container': mix(p.colors[3], bg, 22),
    '--on-tertiary-container': fg,
    '--surface': bg,
    '--surface-container': mix(fg, bg, 6),
    '--surface-container-high': mix(fg, bg, 11),
    '--surface-bright': mix(fg, bg, 8),
    '--on-surface': fg,
    '--on-surface-muted': mix(fg, bg, 68),
    '--nav-text': fg,
    '--outline': mix(fg, bg, 22),
    '--outline-variant': mix(fg, bg, 12),
    '--accent-icon': accent,
    '--scrim': `rgb(0 0 0 / ${dark ? 0.55 : 0.42})`,
    'color-scheme': dark ? 'dark' : 'light'
  }
}

/** Puts the palette on :root as inline properties, which beat both the light and the dark block of tokens.css. */
export function applyPywal(p: PywalPalette | null): void {
  const style = document.documentElement.style
  for (const key of Object.keys(pywalTokens(PLACEHOLDER))) style.removeProperty(key)
  if (!p) return
  for (const [key, value] of Object.entries(pywalTokens(p))) style.setProperty(key, value)
}

const PLACEHOLDER: PywalPalette = { background: '#000000', foreground: '#ffffff', colors: Array(16).fill('#808080') }
