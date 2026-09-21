import { describe, expect, it, vi, beforeEach } from 'vitest'

const existing = new Set<string>()
vi.mock('node:fs', async (orig) => ({ ...(await orig<typeof import('node:fs')>()), existsSync: (p: string) => existing.has(p) }))
const { findBinary } = await import('../src/main/tunnel/macosScriptController')

const BUNDLED = '/Applications/SenAWG.app/Contents/Resources/bin/amneziawg-go'
const SYSTEM = '/usr/local/bin/amneziawg-go'

describe('findBinary', () => {
  beforeEach(() => existing.clear())

  it('prefers the bundled daemon even when a system one exists', () => {
    existing.add(BUNDLED).add(SYSTEM)
    expect(findBinary(BUNDLED, true)).toBe(BUNDLED)
    expect(findBinary(BUNDLED, false)).toBe(BUNDLED)
  })

  it('never falls back to a system copy in a packaged app', () => {
    existing.add(SYSTEM)
    expect(() => findBinary(BUNDLED, true)).toThrow(/переустановите/)
  })

  it('falls back to a system copy in development', () => {
    existing.add(SYSTEM)
    expect(findBinary(BUNDLED, false)).toBe(SYSTEM)
  })

  it('tells the developer how to build it', () => {
    expect(() => findBinary(BUNDLED, false)).toThrow(/npm run build:awg/)
  })
})
