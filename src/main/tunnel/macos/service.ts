import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { MacServiceInfo } from '../../../shared/types'
import { runElevated } from '../elevate'
import { UserCancelledError } from '../TunnelController'
import type { HelperClient, HelperStarter } from '../windows/helperClient'

/** helper/paths_darwin.go: socketPath. launchd opens it and starts the service on the first connection. */
export const SOCKET_PATH = '/var/run/ru.senawg.helper.sock'

/** helper/paths_darwin.go: plistPath. There when the service is installed, whether it runs or not. */
export const PLIST_PATH = '/Library/LaunchDaemons/ru.senawg.helper.plist'

/**
 * The service's files and where they sit under Contents/Resources — helper/macinstall.go: serviceFiles,
 * same order (it is part of the build id).
 */
const SERVICE_FILES: { name: string; source: string }[] = [
  { name: 'awg-helper', source: 'bin/awg-helper' },
  { name: 'amneziawg-go', source: 'bin/amneziawg-go' },
  { name: 'awg.sh', source: 'scripts/awg.sh' }
]

function fileSha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * The build id of the service this app carries: helper/macinstall.go's buildID over the app's own
 * Resources — SHA-256 over "<name>\0<sha256 hex>\n" per file. The installed service reports its own in
 * `hello`; when the two differ, the service is reinstalled (one admin prompt).
 */
export async function serviceBuildId(resources: string): Promise<string> {
  const total = createHash('sha256')
  for (const f of SERVICE_FILES) total.update(`${f.name}\0${await fileSha256(join(resources, f.source))}\n`)
  return total.digest('hex')
}

/**
 * Installs (or replaces) the service from this app's Resources: `awg-helper install` behind the macOS
 * admin prompt — the one password it takes, instead of one per connection. Declining the prompt rejects
 * with UserCancelledError, which the tunnel manager treats as a cancelled connection, not a failure.
 */
export async function installService(resources: string): Promise<void> {
  await runElevated(
    [join(resources, 'bin', 'awg-helper'), 'install', '--from', resources],
    'SenAWG устанавливает свою службу, чтобы дальше включать и выключать VPN без пароля.'
  )
}

/**
 * HelperClient's start step on macOS: a request that finds no socket means no service is installed (or
 * launchd no longer has it), so the answer is to install it. Once installed, launchd starts it on demand
 * and this never runs again — until the service is removed.
 */
export const macStarter = (resources: string): HelperStarter => ({
  start: async () => {
    await installService(resources)
    return 0
  },
  accepted: (code) => code === 0,
  failure: () => null
})

/**
 * What «Настройки → Приложение» shows about the service. `client` must have no starter: looking must
 * never install anything. Asking an installed one is free — launchd starts it for the question.
 */
export async function readMacService(resources: string, client: HelperClient, plist = PLIST_PATH): Promise<MacServiceInfo> {
  if (!existsSync(plist)) return { installed: false }
  try {
    const [hello, expected] = await Promise.all([client.request({ op: 'hello' }, 3_000), serviceBuildId(resources)])
    return { installed: true, version: hello.helper, current: hello.build === expected }
  } catch {
    return { installed: true }
  }
}

/**
 * `awg-helper uninstall` behind the admin prompt: the service out of launchd and off the disk, with
 * awg.sh's state. The app keeps working — the next connection installs the service again.
 */
export async function removeMacService(resources: string, run: typeof runElevated = runElevated): Promise<'done' | 'cancelled'> {
  try {
    await run([join(resources, 'bin', 'awg-helper'), 'uninstall'], 'SenAWG удаляет свою службу.')
    return 'done'
  } catch (err) {
    if (err instanceof UserCancelledError) return 'cancelled'
    throw err
  }
}
