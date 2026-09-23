import { join } from 'node:path'
import type { EngineInfo } from '../../shared/types'
import type { Backend, BackendOptions } from './backend'
import { FileTail } from './fileTail'
import { probeTunnel } from './healthCheck'
import { WindowsHelperController } from './windowsHelperController'
import { HELPER_PIPE, HelperClient } from './windows/helperClient'
import { helperNetProbes } from './windows/netProbes'
import { scStart } from './windows/serviceStart'

/** The service mirrors the tunnel's log here; the folder lets every user read it (see helper/secure_windows.go). */
export const daemonLogPath = (programData = process.env['ProgramData'] ?? 'C:\\ProgramData'): string =>
  join(programData, 'SenAWG', 'daemon.log')

export function createWindowsBackend({ logger, dnsFor, daemonLines }: BackendOptions, pipe = HELPER_PIPE): Backend {
  const client = new HelperClient(pipe, scStart)
  const controller = new WindowsHelperController(client, (level, message) => logger.add(level, 'app', message), dnsFor)
  const net = helperNetProbes(client)
  return {
    controller,
    tail: new FileTail(daemonLogPath(), daemonLines),
    probe: (stats) => probeTunnel(stats, net),
    async describe(): Promise<EngineInfo> {
      // Throws, with a message for the user, when the service is not running or is of another version.
      const hello = await controller.hello()
      return {
        engine: `amneziawg-go ${hello.awgGo ?? '(версия не определена)'}`,
        detail: `в службе SenAWG${hello.helper ? ` ${hello.helper}` : ''}`
      }
    }
  }
}
