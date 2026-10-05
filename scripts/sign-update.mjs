#!/usr/bin/env node
// Signs the installers the deploy job uploads, so the application installs only what we built
// (src/main/update/signature.ts). Next to each SenAWG-<v>-setup.exe / -linux-x64.run / -arm64.dmg it
// writes <file>.sig: base64 of the Ed25519 signature over the lines updateMessage() builds. The same for
// each <installer>.files.json (make-delta.mjs): the list an update in pieces is put together by.
//
//   node scripts/sign-update.mjs <dir>              signs with UPDATE_SIGNING_KEY (base64 PKCS#8 DER)
//   node scripts/sign-update.mjs keygen <file>      new key: the private half into <file> (0600), the
//                                                   public one printed, for UPDATE_KEYS
//
// It refuses a key whose public half is not in UPDATE_KEYS: an update signed with it would be thrown
// away by every copy of the application, and they would stop updating. --skip-app-check is for tests.
import crypto from 'node:crypto'
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const KEYS_FILE = join(ROOT, 'src/main/update/signature.ts')

/** Which system each installer is for — the same names server.ts accepts. */
const KINDS = [
  { os: 'windows', re: /^SenAWG-[\w.-]+-setup\.exe$/i },
  { os: 'linux', re: /^SenAWG-[\w.-]+-linux-x64\.run$/i },
  { os: 'macos', re: /^SenAWG-[\w.-]+-arm64\.dmg$/i }
]

const fail = (message) => {
  console.error(`sign-update: ${message}`)
  process.exit(1)
}

/** signature.ts: updateMessage. */
const message = (os, name, size, sha256) => ['senawg-update-v1', os, name, String(size), sha256].join('\n')

const rawPublic = (key) => crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    createReadStream(file)
      .on('error', reject)
      .on('data', (c) => hash.update(c))
      .on('end', () => resolve(hash.digest('hex')))
  })
}

const args = process.argv.slice(2)

if (args[0] === 'keygen') {
  const out = args[1] ?? fail('usage: sign-update.mjs keygen <file>')
  if (existsSync(out)) fail(`${out} уже есть — ключ не перезаписывается`)
  const { privateKey } = crypto.generateKeyPairSync('ed25519')
  writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') + '\n', { mode: 0o600, flag: 'wx' })
  console.log(`Закрытый ключ: ${out}`)
  console.log(`Открытый (в UPDATE_KEYS): ${rawPublic(privateKey)}`)
  process.exit(0)
}

const skipAppCheck = args.includes('--skip-app-check')
const dir = args.find((a) => !a.startsWith('--')) ?? fail('usage: sign-update.mjs <dir> [--skip-app-check]')
const secret = process.env.UPDATE_SIGNING_KEY?.trim() || fail('нет UPDATE_SIGNING_KEY')
let key
try {
  key = crypto.createPrivateKey({ key: Buffer.from(secret, 'base64'), format: 'der', type: 'pkcs8' })
} catch {
  fail('UPDATE_SIGNING_KEY — не ключ Ed25519 в base64 (PKCS#8 DER)')
}
if (key.asymmetricKeyType !== 'ed25519') fail('UPDATE_SIGNING_KEY — не ключ Ed25519')
const pub = rawPublic(key)
if (!skipAppCheck && !readFileSync(KEYS_FILE, 'utf8').includes(`'${pub}'`)) {
  fail(`открытого ключа ${pub} нет в UPDATE_KEYS (${KEYS_FILE}) — приложение не примет такую подпись`)
}

let signed = 0
for (const name of readdirSync(dir).sort()) {
  // A list of files is signed as itself, under its own name: never mistaken for the installer.
  const kind = KINDS.find((k) => k.re.test(name.replace(/\.files\.json$/, '')))
  if (!kind) continue
  const file = join(dir, name)
  const { size } = statSync(file)
  const sig = crypto.sign(null, Buffer.from(message(kind.os, name, size, await sha256(file)), 'utf8'), key)
  writeFileSync(`${file}.sig`, sig.toString('base64') + '\n')
  console.log(`${name} (${kind.os}): подписан`)
  signed++
}
if (!signed) fail(`в ${dir} нет установщиков SenAWG`)
