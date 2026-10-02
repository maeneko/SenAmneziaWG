import { describe, expect, it } from 'vitest'
import { parsePywal } from '../src/main/pywal'

const colors = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`color${i}`, '#112233']))

describe('parsePywal', () => {
  it('reads a pywal colors.json', () => {
    const text = JSON.stringify({ special: { background: '#000000', foreground: '#ffffff', cursor: '#ffffff' }, colors })
    const p = parsePywal(text)
    expect(p?.background).toBe('#000000')
    expect(p?.colors).toHaveLength(16)
  })

  it('refuses anything that is not a full #rrggbb palette', () => {
    expect(parsePywal('not json')).toBeNull()
    expect(parsePywal(JSON.stringify({ special: { background: 'red', foreground: '#fff' }, colors }))).toBeNull()
    expect(parsePywal(JSON.stringify({ special: { background: '#000000', foreground: '#ffffff' }, colors: { color0: '#000000' } }))).toBeNull()
  })
})
