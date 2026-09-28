import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { distroFamily, hasCommand, packageHint } from '../src/main/linuxPackages'

// The ID and ID_LIKE lines as these distributions ship them.
const OS = {
  artix: 'NAME="Artix Linux"\nPRETTY_NAME="Artix Linux"\nID="artix"\nID_LIKE="arch"\n',
  arch: 'NAME="Arch Linux"\nID=arch\n',
  manjaro: 'NAME="Manjaro Linux"\nID="manjaro"\nID_LIKE="arch"\n',
  endeavour: 'NAME="EndeavourOS"\nID="endeavouros"\nID_LIKE="arch"\n',
  ubuntu: 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n',
  mint: 'NAME="Linux Mint"\nID=linuxmint\nID_LIKE="ubuntu debian"\n',
  debian: 'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nID=debian\n',
  fedora: 'NAME="Fedora Linux"\nID=fedora\n',
  alma: 'NAME="AlmaLinux"\nID="almalinux"\nID_LIKE="rhel centos fedora"\n',
  tumbleweed: 'NAME="openSUSE Tumbleweed"\nID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\n',
  void: 'NAME="Void"\nID="void"\n',
  alpine: 'NAME="Alpine Linux"\nID=alpine\n'
}

describe('distroFamily', () => {
  it('tells the families apart by ID, then ID_LIKE', () => {
    expect(distroFamily(OS.artix)).toBe('artix')
    expect([OS.arch, OS.manjaro, OS.endeavour].map(distroFamily)).toEqual(['arch', 'arch', 'arch'])
    expect([OS.ubuntu, OS.mint, OS.debian].map(distroFamily)).toEqual(['debian', 'debian', 'debian'])
    expect([OS.fedora, OS.alma].map(distroFamily)).toEqual(['fedora', 'fedora'])
    expect(distroFamily(OS.tumbleweed)).toBe('suse')
  })

  it('knows no family for the rest, or without os-release', () => {
    expect(distroFamily(OS.void)).toBeNull()
    expect(distroFamily(OS.alpine)).toBeNull()
    expect(distroFamily('')).toBeNull()
  })
})

describe('packageHint', () => {
  it("names the distribution's package and the command that installs it", () => {
    expect(packageHint('pkexec', OS.artix)).toBe('polkit: sudo pacman -S --needed polkit')
    expect(packageHint('pkexec', OS.ubuntu)).toBe('pkexec: sudo apt install pkexec')
    expect(packageHint('pkexec', OS.alma)).toBe('polkit: sudo dnf install polkit')
    expect(packageHint('zstd', OS.tumbleweed)).toBe('zstd: sudo zypper install zstd')
  })

  it('names only the package where the distribution is not known', () => {
    expect(packageHint('pkexec', OS.void)).toBe('polkit')
  })
})

describe('hasCommand', () => {
  it('finds an executable on PATH, not a plain file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'senawg-path-'))
    writeFileSync(join(dir, 'runs'), '#!/bin/sh\n')
    chmodSync(join(dir, 'runs'), 0o755)
    writeFileSync(join(dir, 'plain'), '')
    expect(hasCommand('runs', dir)).toBe(true)
    expect(hasCommand('plain', dir)).toBe(false)
    expect(hasCommand('senawg-no-such-program', dir)).toBe(false)
  })
})
