// macOS shows UNUserNotificationCenter notifications only for a bundle that is properly signed: npm's
// Electron.app is linker-signed, with its Info.plist and resources left unbound, and Notification then
// fails with «UNErrorDomain, ошибка 1». Signing it ad-hoc before every dev run (it is a local, unsigned
// build anyway) binds the bundle, so the very same Notification code works as it does once installed.
// Linux and Windows need none of this; a failed signing is only a dev convenience lost, never a blocker.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

if (process.platform !== 'darwin') process.exit(0)

let exe
try {
  exe = createRequire(import.meta.url)('electron')
} catch {
  process.exit(0)
}
// Inside Electron `require('electron')` is the API object; in Node it is the path to the binary.
if (typeof exe !== 'string') process.exit(0)
const app = dirname(dirname(dirname(exe)))
if (!app.endsWith('.app')) process.exit(0)

const info = spawnSync('codesign', ['-dv', '--verbose=2', app], { encoding: 'utf8' })
const text = `${info.stdout}${info.stderr}`
const bound = /Info\.plist entries=\d+/.test(text) && !/Info\.plist=not bound/.test(text) && /Sealed Resources version=\d/.test(text)
if (bound) process.exit(0)

console.log('macOS: подписываю Electron.app, чтобы системные уведомления работали в dev…')
const sign = spawnSync('codesign', ['--deep', '--force', '--sign', '-', app], { stdio: 'inherit' })
if (sign.status !== 0) console.log('Не удалось подписать Electron.app — системные уведомления в dev не появятся.')
