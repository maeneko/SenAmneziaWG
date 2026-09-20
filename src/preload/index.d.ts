import type { AwgApi, AwgSetupApi } from '../shared/types'

declare global {
  interface Window {
    awg: AwgApi
    /** Only in the setup window. */
    awgSetup?: AwgSetupApi
  }
}
