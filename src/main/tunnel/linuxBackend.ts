import type { EngineInfo } from '../../shared/types'
import type { Backend, BackendOptions } from './backend'
import { FileTail } from './fileTail'
import { probeTunnel } from './healthCheck'
import { LinuxHelperController } from './linuxHelperController'
import { HELPER_PATH, linuxStarter } from './linux/serviceStart'
import { serviceVault } from './linux/serviceVault'
import { HelperClient } from './windows/helperClient'
import { helperNetProbes } from './windows/netProbes'

/** helper/paths_linux.go: socketPath. World-writable like the Windows pipe's IU right — see socket_linux.go. */
export const SOCKET_PATH = '/run/senawg/helper.sock'

/** helper/paths_linux.go: dirs.daemonLog(). World-readable, same reasoning as Windows's daemon.log. */
export const DAEMON_LOG_PATH = '/run/senawg/daemon.log'

export function createLinuxBackend({ logger, dnsFor, daemonLines }: BackendOptions, socketPath = SOCKET_PATH): Backend {
  const client = new HelperClient(socketPath, linuxStarter(HELPER_PATH()))
  const controller = new LinuxHelperController(client, (level, message) => logger.add(level, 'app', message), dnsFor)
  const net = helperNetProbes(client)
  return {
    controller,
    tail: new FileTail(DAEMON_LOG_PATH, daemonLines),
    vault: serviceVault(client),
    async signSen(id, message) {
      const res = await client.request({ op: 'sen-sign', id, message })
      if (!res.sig) throw new Error('Служба SenAWG не вернула подпись')
      return Buffer.from(res.sig, 'base64url')
    },
    probe: (stats) => probeTunnel(stats, net),
    async describe(): Promise<EngineInfo> {
      const hello = await controller.hello()
      return {
        engine: `amneziawg-go ${hello.awgGo ?? '(версия не определена)'}`,
        detail: `в службе SenAWG${hello.helper ? ` ${hello.helper}` : ''}`
      }
    }
  }
}
