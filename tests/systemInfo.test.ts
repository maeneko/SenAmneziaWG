import { describe, expect, it } from 'vitest'
import { parseOsRelease } from '../src/main/systemInfo'

describe('parseOsRelease', () => {
  it('reads PRETTY_NAME, quoted or not', () => {
    expect(parseOsRelease('NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\nID=ubuntu\n')).toBe('Ubuntu 24.04.1 LTS')
    expect(parseOsRelease("PRETTY_NAME='Fedora Linux 40'\n")).toBe('Fedora Linux 40')
    expect(parseOsRelease('PRETTY_NAME=Arch Linux\n')).toBe('Arch Linux')
  })
  it('gives null without it', () => expect(parseOsRelease('NAME=Foo\n')).toBeNull())
})
