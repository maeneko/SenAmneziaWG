// Writes the reference results of the desktop's pure logic (config parsing, UAPI, stats, redaction…) as JSON,
// for the Android app's tests: `node scripts/dump-golden.mjs ../senawg-android/app/src/test/resources/golden.json`.
import { build } from 'esbuild'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = process.argv[2]
if (!out) {
  console.error('usage: node scripts/dump-golden.mjs <out.json>')
  process.exit(1)
}

const dir = mkdtempSync(join(tmpdir(), 'senawg-golden-'))
try {
  const bundle = join(dir, 'cases.mjs')
  await build({
    entryPoints: [resolve(import.meta.dirname, 'golden/cases.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: bundle,
    logLevel: 'error'
  })
  const { buildGolden } = await import(pathToFileURL(bundle).href)
  mkdirSync(dirname(resolve(out)), { recursive: true })
  writeFileSync(out, JSON.stringify(buildGolden(), null, 2) + '\n')
  console.log(`golden → ${resolve(out)}`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
