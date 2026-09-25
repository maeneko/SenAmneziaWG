// Builds the Linux .run artifact: electron-builder's `dir` target (its linux-unpacked output directory),
// wrapped by make-run.sh into the self-extracting stub the site offers (update/server.ts's
// SenAWG-<version>-linux-<arch>.run). x64 only: arm64 is not built.
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const fail = (m) => {
  console.error(m)
  process.exit(1)
}

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' })
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} завершился с ошибкой`)
}

for (const [arch, unpackedName] of [['x64', 'linux-unpacked']]) {
  console.log(`\n=== SenAWG для Linux/${arch} ===`)
  run('npx', ['electron-builder', '--linux', 'dir', `--${arch}`])
  const unpacked = join(root, 'dist', unpackedName)
  if (!existsSync(unpacked)) fail(`electron-builder не создал ${unpacked}`)
  const out = join(root, 'dist', `SenAWG-${version}-linux-${arch}.run`)
  run('bash', [join(root, 'scripts', 'make-run.sh'), unpacked, version, arch, out])
}
