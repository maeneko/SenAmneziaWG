import { describe, expect, it } from 'vitest'
import { buildId } from '../src/main/buildId'

describe('buildId', () => {
  it('is {channel}-{version}-{os}', () => {
    expect(buildId('0.1.0', 'darwin')).toBe('beta-0.1.0-mac')
    expect(buildId('0.1.0', 'win32')).toBe('beta-0.1.0-win')
  })

  it('carries the version through as given', () => {
    expect(buildId('1.2.3-rc.1', 'win32')).toBe('beta-1.2.3-rc.1-win')
  })

  it('names an unsupported platform rather than inventing a short form', () => {
    expect(buildId('0.1.0', 'linux')).toBe('beta-0.1.0-linux')
  })
})
