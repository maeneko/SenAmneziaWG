import type { AwgApi } from '../shared/types'

declare global {
  interface Window {
    awg: AwgApi
  }
}
