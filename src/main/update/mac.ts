import { execFile, spawn } from 'node:child_process'
import { access, constants, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { updatedArgs, type RelaunchArgs } from '../setup/mode'

const BUNDLE_ID = 'com.senawg.desktop'

const run = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5 * 60_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${basename(file)}: ${(stderr || err.message).trim()}`))
      else resolve(stdout.trim())
    })
  })

/** «/Applications/SenAWG.app» for «/Applications/SenAWG.app/Contents/MacOS/SenAWG»; null outside a bundle. */
export function bundleOf(exe: string): string | null {
  const at = exe.lastIndexOf('.app/Contents/MacOS/')
  return at < 0 ? null : exe.slice(0, at + '.app'.length)
}

/**
 * Where a copy cannot be replaced: straight from the disk image, or moved by Gatekeeper into a random
 * read-only folder (App Translocation — a downloaded app started where it was unpacked, never moved).
 */
export function cannotReplace(bundle: string): string | null {
  if (bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) {
    return 'Перенесите SenAWG в папку «Программы» и откройте оттуда: копию, запущенную с образа диска или из «Загрузок», обновить нельзя'
  }
  return null
}

const plist = (app: string, key: string): Promise<string> =>
  run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(app, 'Contents', 'Info.plist')])

/**
 * Stages the new version from the downloaded disk image beside the running one: `<folder>/.SenAWG-<v>.app`,
 * on the same volume, so that the swap after this process has gone is a rename. The way Chrome's Keystone
 * does it: the new files go in while the old version keeps running on its own, and nothing the running copy
 * uses is touched until it has quit. Returns the staged bundle.
 */
async function stage(dmg: string, version: string, bundle: string): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), 'senawg-dmg-'))
  const mount = join(work, 'mnt')
  const staged = join(dirname(bundle), `.SenAWG-${version}.app`)
  await run('/usr/bin/hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount])
  try {
    const name = (await readdir(mount)).find((f) => f.endsWith('.app'))
    if (!name) throw new Error('В образе обновления нет приложения')
    const source = join(mount, name)
    // Only our own application, and the version the site announced.
    if ((await plist(source, 'CFBundleIdentifier')) !== BUNDLE_ID) throw new Error('В образе обновления чужое приложение')
    const found = await plist(source, 'CFBundleShortVersionString')
    if (found !== version) throw new Error(`В образе обновления версия ${found}, а не ${version}`)

    await rm(staged, { recursive: true, force: true })
    await run('/usr/bin/ditto', [source, staged])
    // Downloaded by this process, so not quarantined; cleared anyway, as Keystone does, so the first start
    // of the new version never stops at a Gatekeeper question.
    await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', staged]).catch(() => undefined)
    return staged
  } catch (err) {
    await rm(staged, { recursive: true, force: true })
    throw err
  } finally {
    await run('/usr/bin/hdiutil', ['detach', mount, '-force']).catch(() => undefined)
    await rm(work, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Runs once this process has gone. Like Chrome's relauncher it learns that from a pipe, not from the pid,
 * which another process may have taken by then: `cat` returns when the application's end of stdin closes,
 * and that happens only when the application exits. Then the swap — two renames, the old copy put back if
 * the second fails — and the application is opened again through Launch Services. It announces the version
 * it expects (`--updated=`), so the old one, put back, does not claim to be the update.
 */
const RELAUNCH = `
cat >/dev/null
app=$1 staged=$2 old=$3
shift 3
if mv "$app" "$old"; then
  if mv "$staged" "$app"; then rm -rf "$old"; else mv "$old" "$app"; rm -rf "$staged"; fi
else
  rm -rf "$staged"
fi
exec /usr/bin/open -n "$app" --args "$@"
`

/**
 * macOS: there is no installer — the site offers the same disk image people drag into «Программы». The new
 * version is staged beside the running one, and a small script swaps them and opens the new one once this
 * process has quit. The caller quits right after this resolves; before that, nothing on disk has changed.
 */
export async function installMacUpdate(dmg: string, version: string, exe: string, relaunch: Omit<RelaunchArgs, 'version'>): Promise<void> {
  const bundle = bundleOf(exe)
  if (!bundle) throw new Error('Не найдено, где установлен SenAWG')
  const refused = cannotReplace(bundle)
  if (refused) throw new Error(refused)
  // Standard for an administrator's account: «Программы» is writable by the admin group. Anyone else
  // updates the way they installed — by dragging the new version in.
  try {
    await access(dirname(bundle), constants.W_OK)
    await access(bundle, constants.W_OK)
  } catch {
    throw new Error(`Нет прав на запись в ${dirname(bundle)}: скачайте новую версию с сайта и перетащите её в «Программы»`)
  }

  const staged = await stage(dmg, version, bundle)
  const old = join(dirname(bundle), `.SenAWG-old-${process.pid}.app`)
  const child = spawn('/bin/sh', ['-c', RELAUNCH, 'relaunch', bundle, staged, old, ...updatedArgs({ version, ...relaunch })], {
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore']
  })
  await new Promise<void>((resolve, reject) => {
    child.once('error', (err) => reject(new Error(`Не удалось подготовить перезапуск: ${err.message}`)))
    child.once('spawn', () => resolve())
  }).catch(async (err: unknown) => {
    await rm(staged, { recursive: true, force: true })
    throw err
  })
  // The pipe stays open, unwritten, until this process exits; neither end may keep the application alive.
  child.unref()
  ;(child.stdin as unknown as { unref?: () => void } | null)?.unref?.()
  void rm(dmg, { force: true }).catch(() => undefined)
}
