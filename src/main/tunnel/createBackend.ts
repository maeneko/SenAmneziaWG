import type { Backend, BackendOptions } from './backend'
import { createLinuxBackend } from './linuxBackend'
import { createMacosBackend } from './macosBackend'
import { createWindowsBackend } from './windowsBackend'

/** The one place that knows which tunnel engine the current platform uses. */
export function createBackend(options: BackendOptions, platform: NodeJS.Platform = process.platform): Backend {
  switch (platform) {
    case 'darwin':
      return createMacosBackend(options)
    case 'win32':
      return createWindowsBackend(options)
    case 'linux':
      return createLinuxBackend(options)
    default:
      throw new Error('SenAWG работает только на macOS, Windows и Linux')
  }
}
