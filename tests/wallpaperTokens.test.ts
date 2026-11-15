import { describe, expect, it } from 'vitest'
import { accentTokens, relativeLuminance, type Seed } from '../src/renderer/src/lib/wallpaper'

const seed: Seed = { h: 45, s: 0.85 }

/** The saturation the CSS carries, in percent. A fraction written bare (`0.85`) would read as
 *  0.85%, which is the bug these tokens once shipped with. */
const saturation = (css: string): number => Number(/^hsl\(\d+ ([\d.]+)%/.exec(css)?.[1])

/** HSL back to sRGB for the contrast check (same mapping the module uses). */
function rgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] = h < 60 ? [c, x, 0]
    : h < 120 ? [x, c, 0]
      : h < 180 ? [0, c, x]
        : h < 240 ? [0, x, c]
          : h < 300 ? [x, 0, c] : [c, 0, x]
  return [r + m, g + m, b + m]
}

describe('accentTokens', () => {
  it('writes seed saturations as percentages', () => {
    const light = accentTokens([seed], false)
    expect(saturation(light['--primary'])).toBeCloseTo(85, 0)
    expect(saturation(light['--secondary-container'])).toBeCloseTo(85, 0)
    expect(saturation(light['--accent-icon'])).toBeCloseTo(85, 0)
  })

  it('keeps white text readable on the light scheme\'s primary', () => {
    for (const h of [0, 45, 90, 165, 220, 280, 330]) {
      const brand = { h, s: 0.85 }
      const primary = accentTokens([brand], false)['--primary']
      const [, l] = /^hsl\(\d+ [\d.]+% ([\d.]+)%\)$/.exec(primary) ?? []
      const [r, g, b] = rgb(h, 0.85, Number(l) / 100)
      expect(relativeLuminance(r, g, b)).toBeLessThanOrEqual(0.165)
    }
  })

  it('tints the dark scheme\'s on-primary with the seed, not a fixed brown', () => {
    const tokens = accentTokens([{ h: 165, s: 0.62 }], true)
    expect(tokens['--on-primary']).toMatch(/^hsl\(165 [\d.]+% 16%\)$/)
  })
})
