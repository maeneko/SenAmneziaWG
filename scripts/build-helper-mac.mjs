// Builds the macOS SenAWG service, resources/bin/awg-helper: a universal (arm64 + x86_64) binary from
// helper/, next to the amneziawg-go that scripts/build-amneziawg.sh puts there. Unlike the Linux and
// Windows helpers it needs cgo (launch_activate_socket, helper/launchd_darwin.go), so it is built on
// macOS only, with the Xcode command line tools' clang for both architectures.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const helperDir = join(root, 'helper')
const out = join(root, 'resources', 'bin', 'awg-helper')
// The same floor as build-amneziawg.sh.
const MIN_MACOS = '11.0'
const fail = (message) => {
  console.error(message)
  process.exit(1)
}
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: 'inherit', ...opts })

if (process.platform !== 'darwin') fail('awg-helper для macOS собирается только на macOS (нужен cgo)')
const go = spawnSync('go', ['version'], { encoding: 'utf8' })
if (go.error || go.status !== 0) fail('Нужен Go (brew install go)')

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const work = mkdtempSync(join(tmpdir(), 'senawg-helper-'))
try {
  const parts = []
  for (const [goarch, clangArch] of [
    ['arm64', 'arm64'],
    ['amd64', 'x86_64']
  ]) {
    console.log(`→ awg-helper (darwin/${goarch}, ${version})`)
    const part = join(work, `awg-helper-${goarch}`)
    const flags = `-arch ${clangArch} -mmacosx-version-min=${MIN_MACOS}`
    const env = {
      ...process.env,
      GOOS: 'darwin',
      GOARCH: goarch,
      CGO_ENABLED: '1',
      CC: 'clang',
      CGO_CFLAGS: flags,
      CGO_LDFLAGS: flags,
      MACOSX_DEPLOYMENT_TARGET: MIN_MACOS
    }
    const res = run('go', ['build', '-trimpath', '-ldflags', `-s -w -X main.version=${version}`, '-o', part, '.'], { cwd: helperDir, env })
    if (res.status !== 0) fail(`Не удалось собрать awg-helper (darwin/${goarch})`)
    parts.push(part)
  }

  mkdirSync(dirname(out), { recursive: true })
  const universal = join(work, 'awg-helper')
  if (run('lipo', ['-create', '-output', universal, ...parts]).status !== 0) fail('lipo не смог собрать universal-бинарник')
  // Ad-hoc signature: arm64 refuses to run unsigned code. electron-builder re-signs it with the app (mac.binaries).
  if (run('codesign', ['--force', '--sign', '-', universal]).status !== 0) fail('codesign не подписал awg-helper')
  if (run('install', ['-m', '755', universal, out]).status !== 0) fail(`Не удалось записать ${out}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}

run('lipo', ['-info', out])
console.log(`Готово: ${out} (${(statSync(out).size / 1024).toFixed(0)} КБ)`)
