// Builds the tunnel engine that ships with the app. Never fails `npm install`: a missing Go toolchain
// only means the engine has to be built later with `npm run build:awg` / `npm run build:helper`.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const steps = {
  darwin: { cmd: join(here, 'build-amneziawg.sh'), args: [], hint: 'amneziawg-go не собран (нужен Go) — npm run build:awg' },
  win32: {
    cmd: process.execPath,
    args: [join(here, 'build-helper-win.mjs')],
    hint: 'awg-helper.exe не собран (нужен Go) — npm run build:helper'
  }
}

const step = steps[process.platform]
if (step && existsSync(step.args[0] ?? step.cmd)) {
  const r = spawnSync(step.cmd, step.args, { stdio: 'inherit' })
  if (r.status !== 0) console.log(step.hint)
}
