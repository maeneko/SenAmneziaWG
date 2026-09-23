import { join } from 'node:path'
import type { EngineInfo } from '../../shared/types'
import type { Backend, BackendOptions } from './backend'
import { parseBinaryVersion, readBinaryVersion } from './binaryVersion'
import { FileTail } from './fileTail'
import { DAEMON_LOG, MacosScriptController } from './macosScriptController'

export function createMacosBackend({ resources, userData, packaged, logger, diagnostics, dnsFor, daemonLines }: BackendOptions): Backend {
  const controller = new MacosScriptController(
    join(resources, 'scripts'),
    join(userData, 'run'),
    join(resources, 'bin', 'amneziawg-go'),
    packaged,
    (level, message) => logger.add(level, 'app', message),
    diagnostics,
    dnsFor
  )
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
