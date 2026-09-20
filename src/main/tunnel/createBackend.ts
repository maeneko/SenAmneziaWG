import type { Backend, BackendOptions } from './backend'
import { createMacosBackend } from './macosBackend'
import { createWindowsBackend } from './windowsBackend'

/** The one place that knows which tunnel engine the current platform uses. */
export function createBackend(options: BackendOptions, platform: NodeJS.Platform = process.platform): Backend {
  switch (platform) {
    case 'darwin':
      return createMacosBackend(options)
    case 'win32':
      return createWindowsBackend(options)
    default:
      throw new Error('AmnesiaWG работает только на macOS и Windows')
  }
}
