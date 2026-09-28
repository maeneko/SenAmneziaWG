import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// scripts/run-deps.sh, the .run's own check, with ldd, getconf and apt-cache played by stand-ins: what
// the real ones print on a machine missing some of the Electron binary's libraries.
const ROOT = resolve(__dirname, '..')
const RUN_DEPS = join(ROOT, 'scripts', 'run-deps.sh')

const OS = {
  artix: 'NAME="Artix Linux"\nID="artix"\nID_LIKE="arch"\n',
  ubuntu: 'NAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nID_LIKE=debian\n',
  debian12: 'NAME="Debian GNU/Linux"\nVERSION_ID="12"\nID=debian\n',
  fedora: 'NAME="Fedora Linux"\nID=fedora\n',
  void: 'NAME="Void"\nID="void"\n'
}

interface Machine {
  osRelease: string
  /** The libraries ldd reports «not found». */
  missing?: string[]
  /** getconf GNU_LIBC_VERSION's number; null for musl, which has no such variable. */
  glibc?: string | null
  /** The packages apt-cache knows (the t64 renames among them). */
  apt?: string[]
}

function machine(m: Machine): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'senawg-deps-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const tool = (name: string, body: string): void => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  writeFileSync(join(dir, 'os-release'), m.osRelease)
  writeFileSync(
    join(dir, 'ldd.out'),
    ['\tlinux-vdso.so.1 (0x00007ffc)', ...(m.missing ?? []).map((l) => `\t${l} => not found`), '\tlibc.so.6 => /usr/lib/libc.so.6'].join('\n') + '\n'
  )
  tool('ldd', `cat '${join(dir, 'ldd.out')}'`)
  const glibc = m.glibc === undefined ? '2.39' : m.glibc
  tool('getconf', glibc === null ? 'exit 1' : `echo "glibc ${glibc}"`)
  tool('apt-cache', `for p in ${(m.apt ?? []).join(' ')}; do [ "$2" = "$p" ] && exit 0; done; exit 100`)
  return {
    dir,
    env: { PATH: `${bin}:${process.env.PATH}`, SENAWG_OS_RELEASE: join(dir, 'os-release'), LC_ALL: 'C' }
  }
}

const sh = (m: Machine, call: string): string => {
  const { env } = machine(m)
  return execFileSync('sh', ['-c', `set -eu; . '${RUN_DEPS}'; ${call}`], { env, encoding: 'utf8' })
}
const missing = (m: Machine): string => sh(m, 'senawg_missing /app/senawg')

describe('run-deps.sh: senawg_missing', () => {
  it('says nothing when everything is there', () => {
    expect(missing({ osRelease: OS.artix })).toBe('')
  })

  it("names the libraries and the command in the distribution's own package names", () => {
    const out = missing({ osRelease: OS.artix, missing: ['libgtk-3.so.0', 'libnss3.so', 'libnssutil3.so', 'libudev.so.1'] })
    expect(out).toContain('libgtk-3.so.0 libnss3.so libnssutil3.so libudev.so.1')
    // nss once for two of its libraries; Artix's libudev is its own package, not systemd-libs.
    expect(out).toContain('sudo pacman -S --needed gtk3 nss libudev\n')
  })

  it('takes the t64 name where the distribution has renamed the package', () => {
    const lost = ['libgtk-3.so.0', 'libasound.so.2', 'libgbm.so.1']
    expect(missing({ osRelease: OS.ubuntu, missing: lost, apt: ['libgtk-3-0t64', 'libasound2t64', 'libgbm1'] })).toContain(
      'sudo apt install libasound2t64 libgbm1 libgtk-3-0t64\n'
    )
    expect(missing({ osRelease: OS.debian12, missing: lost, apt: ['libgtk-3-0', 'libasound2', 'libgbm1'] })).toContain(
      'sudo apt install libasound2 libgbm1 libgtk-3-0\n'
    )
  })

  it('knows where Fedora splits a library off', () => {
    expect(missing({ osRelease: OS.fedora, missing: ['libnssutil3.so', 'libatk-bridge-2.0.so.0'] })).toContain(
      'sudo dnf install at-spi2-atk nss-util\n'
    )
  })

  it('lists the libraries alone on a distribution it does not know, and one not in the table', () => {
    expect(missing({ osRelease: OS.void, missing: ['libgtk-3.so.0'] })).toMatch(/libgtk-3\.so\.0 найдите в репозитории/)
    const out = missing({ osRelease: OS.artix, missing: ['libgtk-3.so.0', 'libepoxy.so.0'] })
    expect(out).toContain('sudo pacman -S --needed gtk3\n')
    expect(out).toMatch(/libepoxy\.so\.0 найдите/)
  })

  it('stops at a glibc too old, or none at all', () => {
    expect(missing({ osRelease: OS.artix, glibc: '2.17', missing: ['libgtk-3.so.0'] })).toMatch(/glibc 2\.25 или новее, в системе — 2\.17/)
    expect(missing({ osRelease: OS.artix, glibc: '2.3' })).toMatch(/в системе — 2\.3/)
    expect(missing({ osRelease: OS.artix, glibc: '2.25' })).toBe('')
    expect(missing({ osRelease: OS.artix, glibc: null })).toMatch(/musl/)
  })
})

describe('run-deps.sh: senawg_hint', () => {
  it('gives the command where the family is known', () => {
    expect(sh({ osRelease: OS.artix }, 'senawg_hint zstd')).toBe('zstd: sudo pacman -S --needed zstd\n')
    expect(sh({ osRelease: OS.void }, 'senawg_hint zstd')).toBe('zstd\n')
  })
})

// The whole header make-run.sh writes, around a stand-in application: the escaping of a shell script
// inside a heredoc is where this breaks, and only running it shows.
const tools = ['zstd', 'sha256sum'].every((t) => spawnSync('sh', ['-c', `command -v ${t}`]).status === 0)

describe.skipIf(!tools)('make-run.sh', () => {
  const build = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'senawg-run-'))
    const unpacked = join(dir, 'linux-unpacked')
    mkdirSync(unpacked)
    writeFileSync(join(unpacked, 'senawg'), '#!/bin/sh\necho "started with $*"\n')
    chmodSync(join(unpacked, 'senawg'), 0o755)
    const out = join(dir, 'SenAWG-test.run')
    execFileSync('bash', [join(ROOT, 'scripts', 'make-run.sh'), unpacked, '0.0.0', 'x64', out], { stdio: 'ignore' })
    return out
  }
  const run = build()

  it('starts the application when nothing is missing', () => {
    const { env } = machine({ osRelease: OS.artix })
    const r = spawnSync('sh', [run], { env: { ...env, HOME: tmpdir() }, encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.stdout).toBe('started with --setup --no-window\n')
    expect(r.status).toBe(0)
  })

  it('stops before it, saying what to install', () => {
    const { env } = machine({ osRelease: OS.artix, missing: ['libgtk-3.so.0'] })
    const r = spawnSync('sh', [run], { env: { ...env, HOME: tmpdir() }, encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('sudo pacman -S --needed gtk3')
  })
})
