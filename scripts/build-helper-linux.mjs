// Builds what ships next to the Linux app, into resources/linux, for x64 (arm64 is not built):
//   awg-helper      from helper/ — pure Go (no cgo), so it cross-compiles from macOS as well
//   amneziawg-go    the tunnel daemon this helper spawns (tunnel_linux.go), built from the exact
//                   version pinned in helper/go.mod — the same one the helper's own library imports
//                   use, so the two can never drift apart the way two separate pins could.
// Works on macOS and Linux alike (Node + Go only).
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const helperDir = join(root, 'helper')
const fail = (message) => {
  console.error(message)
  process.exit(1)
}

const go = spawnSync('go', ['version'], { encoding: 'utf8' })
if (go.error || go.status !== 0) fail('Нужен Go: https://go.dev/dl/')

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const AWG_GO_IMPORT = 'github.com/amnezia-vpn/amneziawg-go/v3'

// Directory names must be electron-builder's own arch names (its `${arch}` extraResources macro,
// electron-builder.yml), not Go's GOARCH — "x64", not "amd64". Mismatching these is exactly the kind
// of thing that only fails at package time, not at `go build` time.
const arches = [{ dir: 'x64', goarch: 'amd64' }]
for (const { dir, goarch } of arches) {
  const out = join(root, 'resources', 'linux', dir)
  mkdirSync(out, { recursive: true })
  const env = { ...process.env, GOOS: 'linux', GOARCH: goarch, CGO_ENABLED: '0' }

  console.log(`→ awg-helper (linux/${goarch}, ${version})`)
  const helper = spawnSync(
    'go',
    ['build', '-trimpath', '-ldflags', `-s -w -X main.version=${version}`, '-o', join(out, 'awg-helper'), '.'],
    { cwd: helperDir, stdio: 'inherit', env }
  )
  if (helper.status !== 0) fail(`Не удалось собрать awg-helper (linux/${goarch})`)

  console.log(`→ amneziawg-go (linux/${goarch}, из helper/go.mod)`)
  const daemon = spawnSync('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', join(out, 'amneziawg-go'), AWG_GO_IMPORT], {
    cwd: helperDir,
    stdio: 'inherit',
    env
  })
  if (daemon.status !== 0) fail(`Не удалось собрать amneziawg-go (linux/${goarch})`)

  for (const f of ['awg-helper', 'amneziawg-go']) console.log(`  ${dir}/${f}  ${(statSync(join(out, f)).size / 1024).toFixed(0)} КБ`)
}
console.log(`Готово: ${join(root, 'resources', 'linux')}`)
