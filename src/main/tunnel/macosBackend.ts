import { join } from 'node:path'
import type { EngineInfo } from '../../shared/types'
import type { Backend, BackendOptions } from './backend'
import { parseBinaryVersion, readBinaryVersion } from './binaryVersion'
import { FileTail } from './fileTail'
import { macStarter, SOCKET_PATH } from './macos/service'
import { DAEMON_LOG, type HelperLog, MacosScriptController } from './macosScriptController'
import { MacosServiceController } from './macosServiceController'
import { HelperClient } from './windows/helperClient'

/**
 * Packaged builds go through the SenAWG service (one admin prompt to install it, none per connection).
 * Development keeps the admin prompt per connection unless SENAWG_MAC_SERVICE=1 — then the service is
 * installed from the project's resources/ (npm run build:awg && npm run build:helper:mac first).
 */
export function usesService(packaged: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return packaged || env['SENAWG_MAC_SERVICE'] === '1'
}

export function createMacosBackend({ resources, userData, packaged, logger, diagnostics, dnsFor, daemonLines }: BackendOptions): Backend {
  const log: HelperLog = (level, message) => logger.add(level, 'app', message)
  const bundledBinary = join(resources, 'bin', 'amneziawg-go')
  const controller = usesService(packaged)
    ? new MacosServiceController(new HelperClient(SOCKET_PATH, macStarter(resources)), resources, bundledBinary, log, diagnostics, dnsFor)
    : new MacosScriptController(join(resources, 'scripts'), join(userData, 'run'), bundledBinary, packaged, log, diagnostics, dnsFor)
  return {
    controller,
    // amneziawg-go writes here as root; awg.sh makes it world-readable, so following it needs no privileges.
    tail: new FileTail(DAEMON_LOG, daemonLines),
    async describe(): Promise<EngineInfo> {
      // Throws, with a message for the user, when there is no daemon to run at all.
      const path = controller.binary()
      const version = parseBinaryVersion(await readBinaryVersion(path))
      const bundled = path.includes('/resources/bin/') || path.includes('/Resources/bin/')
      return {
        engine: `amneziawg-go ${version?.raw ?? '(версия не определена)'}`,
        detail: `${bundled ? 'встроенный' : 'системный'}: ${path}`,
        ...(bundled ? {} : { warning: 'Используется системный amneziawg-go: соберите встроенный командой npm run build:awg' })
      }
    }
  }
}
