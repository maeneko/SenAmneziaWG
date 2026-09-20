// Builds what ships next to the Windows app, into resources/win:
//   awg-helper.exe  from helper/ — pure Go (no cgo), so it cross-compiles from macOS as well
//   wintun.dll      the WireGuard LLC driver library, pinned by hash
// Works on macOS and Windows alike (Node only; `tar` extracts the zip on both).
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Same pin as amneziawg-windows' own build.cmd.
const WINTUN_URL = 'https://www.wintun.net/builds/wintun-0.14.1.zip'
const WINTUN_SHA256 = '07c256185d6ee3652e09fa55c0b673e2624b565e02c4b9091c79ca7d2f24ef51'
const WINTUN_DLL_IN_ZIP = 'wintun/bin/amd64/wintun.dll'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'resources', 'win')
const fail = (message) => {
  console.error(message)
  process.exit(1)
}

const go = spawnSync('go', ['version'], { encoding: 'utf8' })
if (go.error || go.status !== 0) fail('Нужен Go: https://go.dev/dl/')

mkdirSync(out, { recursive: true })

// --- wintun.dll -----------------------------------------------------------------------------------------
const dll = join(out, 'wintun.dll')
const marker = join(out, '.wintun-sha256')
if (existsSync(dll) && existsSync(marker) && readFileSync(marker, 'utf8').trim() === WINTUN_SHA256) {
  console.log('wintun.dll уже на месте')
} else {
  console.log(`→ wintun.dll (${WINTUN_URL})`)
  const work = mkdtempSync(join(tmpdir(), 'awg-wintun-'))
  try {
    const res = await fetch(WINTUN_URL)
    if (!res.ok) fail(`wintun: HTTP ${res.status}`)
    const zip = Buffer.from(await res.arrayBuffer())
    const actual = createHash('sha256').update(zip).digest('hex')
    if (actual !== WINTUN_SHA256) fail(`wintun: хеш не совпал (получен ${actual}, ожидался ${WINTUN_SHA256}) — сборка остановлена`)
    const zipPath = join(work, 'wintun.zip')
    writeFileSync(zipPath, zip)
    const untar = spawnSync('tar', ['-xf', zipPath, '-C', work, WINTUN_DLL_IN_ZIP], { stdio: 'inherit' })
    if (untar.status !== 0) fail('wintun: не удалось распаковать архив')
    copyFileSync(join(work, ...WINTUN_DLL_IN_ZIP.split('/')), dll)
    writeFileSync(marker, WINTUN_SHA256 + '\n')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// --- awg-helper.exe -------------------------------------------------------------------------------------
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
console.log(`→ awg-helper.exe (windows/amd64, ${version})`)
// The service loads wintun.dll as SYSTEM, and `awg-helper setup` copies it from a folder the user can write to:
// the helper is told the hash of the one DLL it may install (helper/setup_windows.go).
const wintunHash = createHash('sha256').update(readFileSync(dll)).digest('hex')
const build = spawnSync(
  'go',
  [
    'build',
    '-trimpath',
    '-ldflags',
    `-s -w -X main.version=${version} -X main.wintunSHA256=${wintunHash}`,
    '-o',
    join(out, 'awg-helper.exe'),
    '.'
  ],
  { cwd: join(root, 'helper'), stdio: 'inherit', env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' } }
)
if (build.status !== 0) fail('Не удалось собрать awg-helper.exe')

for (const f of ['awg-helper.exe', 'wintun.dll']) console.log(`  ${f}  ${(statSync(join(out, f)).size / 1024).toFixed(0)} КБ`)
console.log(`Готово: ${out}`)
