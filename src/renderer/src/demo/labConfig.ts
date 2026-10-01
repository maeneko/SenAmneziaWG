/*
 * The UI lab (src/renderer/demo/lab.html): what its panel decides in place of the main process. Kept apart
 * from lab.ts, which installs the bridge the moment it is imported, so the panel can import this freely.
 */
import type { AppState, ProfileStatus, UpdateState } from '@shared/types'

export type LabPlatform = 'mac' | 'win' | 'linux'

/** The servers and keys the page starts with. */
export type LabPreset = 'empty' | 'one' | 'many' | 'sen' | 'sen-two'

export type LabTheme = 'system' | 'light' | 'dark'

/** The update card's states, as the panel names them; lab.ts turns each into an UpdateState. */
export type LabUpdate =
  | 'idle'
  | 'idle-never'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'ready-declined'
  | 'installing'
  | 'failed-network'
  | 'failed-installing'
  | 'failed-revoked'
  | 'unsupported'

export type LabTraffic = 'zero' | 'some' | 'lots' | 'stale'

/** Notifications the panel can send to the main screen, as the app or MA7 would. */
export type LabNotice = 'ending' | 'overdue' | 'paid' | 'announce' | 'device' | 'unbound'

/**
 * How the made-up main process answers. The page reads it from its parent at the moment of each call, so a
 * change in the panel applies to the next click without reloading.
 */
export interface LabConfig {
  speed: number
  /** «Подключиться»: works; ends in the error state (the script failed); the call itself rejects. */
  connect: 'ok' | 'error' | 'throw' | 'cancel'
  connectError: string
  /** Adding a key: works, or the link is refused. */
  importLink: 'ok' | 'error'
  /** «Проверить скорость». */
  ping: 'fast' | 'slow' | 'none'
  /** «Проверить обновления»: a newer version, nothing newer, no network. */
  updateCheck: 'newer' | 'latest' | 'network'
  /** The master key's server listing the devices. */
  devices: 'ok' | 'error' | 'slow'
  deviceCount: number
  deviceLimit: number
  /** The master key's server answering «Проверить снова». */
  refresh: 'ok' | 'offline' | 'revoked'
  /** MA7 answering «Профиль»: the account, slowly, not found, no network. */
  profile: 'ok' | 'slow' | 'notfound' | 'error'
  profileStatus: ProfileStatus
  /** Days to the end of the paid period; negative: that many days ago. */
  profileDays: number
  balance: number
  monthly: number
  profileKeys: number
  /** MA7 answering «Применить» with a promo code. */
  promo: 'ok' | 'invalid' | 'used' | 'error'
  /** MA7 giving the requisites when «Оплатить» opens. */
  payment: 'ok' | 'slow' | 'error'
  /** MA7 taking «Подтвердить»: the account then turns `processing`. */
  paid: 'ok' | 'error'
  /** «Настройки → Приложение»: what the system allows. */
  optionsSupported: boolean
  canUninstall: boolean
  canRunInBackground: boolean
  autoStart: 'ok' | 'refuse'
  macService: 'none' | 'current' | 'stale' | 'silent'
  macServiceRemove: 'done' | 'cancelled' | 'error'
  uninstall: 'done' | 'failed' | 'cancelled'
}

/** What each platform's build would say about itself. */
export function labDefaults(platform: LabPlatform): LabConfig {
  return {
    speed: 1,
    connect: 'ok',
    connectError: 'Не удалось поднять интерфейс: awg-quick завершился с кодом 1',
    importLink: 'ok',
    ping: 'fast',
    updateCheck: 'newer',
    devices: 'ok',
    deviceCount: 3,
    deviceLimit: 5,
    refresh: 'ok',
    profile: 'ok',
    profileStatus: 'active',
    profileDays: 18,
    balance: 350,
    monthly: 300,
    profileKeys: 2,
    promo: 'ok',
    payment: 'ok',
    paid: 'ok',
    optionsSupported: true,
    canUninstall: platform !== 'mac',
    canRunInBackground: platform === 'win',
    autoStart: 'ok',
    macService: platform === 'mac' ? 'current' : 'none',
    macServiceRemove: 'done',
    uninstall: 'done'
  }
}

/** window.awgLab in the page: the panel's handle on the made-up main process. */
export interface LabControl {
  state(): AppState
  /** The server the main screen shows: the running one, else the last picked, else the first. */
  currentId(): string | null
  setStatus(status: 'down' | 'connecting' | 'up' | 'error', error?: string): void
  patch(patch: Partial<Pick<AppState, 'busy' | 'switching' | 'needsCleanup' | 'degraded' | 'diagnostics'>>): void
  setTraffic(traffic: LabTraffic): void
  /** The master key of the shown server (or the first one). */
  setSub(patch: { status?: 'ok' | 'offline' | 'revoked'; pendingRev?: boolean; plain?: boolean; login?: string }): void
  /**
   * The server forgets this device, as when it is removed in the panel or from another device: the key of the
   * shown server (or the first one) plays out turning `revoked`. setSub({ status: 'ok' }) binds it again.
   */
  unbind(): Promise<void>
  setUpdate(update: LabUpdate): void
  /** «Обновлено до …», as a seamless update's new copy says it. */
  showUpdated(): void
  pushNotice(kind: LabNotice): void
  clearNotices(): void
  /** Something new at MA7's notice center: the window learns of it only on «Обновить» (or the next round). */
  serverNotice(kind: LabNotice): void
  addLogs(count: number, level?: 'info' | 'warn' | 'error'): void
  streamLogs(on: boolean): void
  setTheme(theme: LabTheme): void
  onChange(cb: (state: AppState, update: UpdateState) => void): () => void
}

/** What the page tells its parent through postMessage. */
export interface LabMessage {
  type: 'awg-lab'
  step: 'loaded'
}
