import { describe, expect, it } from 'vitest'
import { bundleOf, cannotReplace } from '../src/main/update/mac'
import { updatedArgs, updatedOf } from '../src/main/setup/mode'

describe('bundleOf', () => {
  it('finds the .app the executable is in', () => {
    expect(bundleOf('/Applications/SenAWG.app/Contents/MacOS/SenAWG')).toBe('/Applications/SenAWG.app')
    expect(bundleOf('/Users/me/Apps/My SenAWG.app/Contents/MacOS/SenAWG')).toBe('/Users/me/Apps/My SenAWG.app')
  })
  it('is null outside a bundle', () => {
    expect(bundleOf('/usr/local/bin/senawg')).toBeNull()
  })
})

describe('cannotReplace', () => {
  it('refuses a copy on the disk image or translocated by Gatekeeper', () => {
    expect(cannotReplace('/Volumes/SenAWG/SenAWG.app')).toMatch(/Программы/)
    expect(cannotReplace('/private/var/folders/x/T/AppTranslocation/ABC/d/SenAWG.app')).toMatch(/Программы/)
  })
  it('accepts an installed copy', () => {
    expect(cannotReplace('/Applications/SenAWG.app')).toBeNull()
  })
})

describe('the macOS relaunch arguments', () => {
  it('come back as they went', () => {
    const r = { version: '0.7.0', bounds: { x: 10, y: 20, width: 420, height: 780 }, reconnect: 'abc', maximized: true }
    expect(updatedOf(['/Applications/SenAWG.app/Contents/MacOS/SenAWG', ...updatedArgs(r)])).toEqual(r)
  })
  it('keep only what there is', () => {
    const r = { version: '0.7.0', bounds: null, reconnect: null, maximized: false }
    expect(updatedArgs(r)).toEqual(['--updated=0.7.0'])
    expect(updatedOf(updatedArgs(r))).toEqual(r)
  })
  it('are absent from an ordinary start', () => {
    expect(updatedOf(['/Applications/SenAWG.app/Contents/MacOS/SenAWG', '-psn_0_12345'])).toBeNull()
  })
})
