#!/usr/bin/env node
// The update in pieces (src/main/update/files.ts): the list of every file of a release and each file as a
// brotli blob named by its SHA-256, so the application downloads only what it does not already have.
//
//   node scripts/make-delta.mjs <tree> <installer-name> <out-dir>
//
// <tree> is what the installer carries: dist/linux-unpacked, or dist/mac-arm64/SenAWG.app. Writes
// <out-dir>/<installer-name>.files.json and <out-dir>/blobs/<sha[0:2]>/<sha>.br; a blob already there
// (the same content twice) is not written again. The deploy job signs the list (sign-update.mjs) and
// uploads the blobs into releases/blobs/ beside every earlier release's, keeping what is there.
import crypto from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'

/** files.ts: FILES_FORMAT. */
const FORMAT = 'senawg-files-v1'
/** From releases/<version>/<list> to releases/blobs/. */
const BLOBS = '../blobs/'

/** The installers, as server.ts and sign-update.mjs know them; the version is in the name. */
const KINDS = [
  { os: 'windows', re: /^SenAWG-([\w.-]+)-setup\.exe$/i },
  { os: 'linux', re: /^SenAWG-([\w.-]+)-linux-x64\.run$/i },
  { os: 'macos', re: /^SenAWG-([\w.-]+)-arm64\.dmg$/i }
]

const fail = (message) => {
  console.error(`make-delta: ${message}`)
  process.exit(1)
}

const [tree, installer, out] = process.argv.slice(2)
if (!tree || !installer || !out) fail('usage: make-delta.mjs <tree> <installer-name> <out-dir>')
if (!statSync(tree, { throwIfNoEntry: false })?.isDirectory()) fail(`нет каталога ${tree}`)
const kind = KINDS.map((k) => ({ os: k.os, m: k.re.exec(installer) })).find((k) => k.m)
if (!kind) fail(`${installer} — не установщик SenAWG`)

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    createReadStream(file)
      .on('error', reject)
      .on('data', (c) => hash.update(c))
      .on('end', () => resolve(hash.digest('hex')))
  })
}

async function pack(file, sha, size) {
  const dir = join(out, 'blobs', sha.slice(0, 2))
  const blob = join(dir, `${sha}.br`)
  if (!existsSync(blob)) {
    mkdirSync(dir, { recursive: true })
    const tmp = `${blob}.tmp`
    const brotli = zlib.createBrotliCompress({
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
        [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size
      }
    })
    await pipeline(createReadStream(file), brotli, createWriteStream(tmp))
    renameSync(tmp, blob)
  }
  return statSync(blob).size
}

const entries = []
let bytes = 0
let packedBytes = 0
async function walk(dir, rel) {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name)
    const path = rel ? `${rel}/${name}` : name
    const st = lstatSync(abs)
    if (st.isDirectory()) {
      entries.push({ path, type: 'dir', mode: st.mode & 0o777 })
      await walk(abs, path)
    } else if (st.isSymbolicLink()) {
      const target = readlinkSync(abs)
      const resolved = posix.normalize(posix.join(posix.dirname(path), target))
      if (target.startsWith('/') || resolved === '..' || resolved.startsWith('../')) fail(`${path}: ссылка за пределы каталога (${target})`)
      entries.push({ path, type: 'link', target })
    } else if (st.isFile()) {
      const sha = await sha256(abs)
      const packed = await pack(abs, sha, st.size)
      entries.push({ path, type: 'file', mode: st.mode & 0o777, size: st.size, sha256: sha, packed })
      bytes += st.size
      packedBytes += packed
    } else fail(`${path}: не файл, не каталог и не ссылка`)
  }
}
await walk(tree, '')

mkdirSync(out, { recursive: true })
const list = join(out, `${installer}.files.json`)
writeFileSync(list, JSON.stringify({ format: FORMAT, os: kind.os, version: kind.m[1], blobs: BLOBS, entries }) + '\n')
const mb = (n) => (n / 1024 / 1024).toFixed(1)
console.log(`${list}: ${entries.length} записей, ${mb(bytes)} МБ, в блобах ${mb(packedBytes)} МБ`)
