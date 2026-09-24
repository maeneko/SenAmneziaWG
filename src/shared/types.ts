import type { UiSettings } from './uiSettings'

export type TunnelStatus = 'down' | 'connecting' | 'up' | 'error'

export interface AwgParams {
  jc: number
  jmin: number
  jmax: number
  s1: number
  s2: number
  h1: string
  h2: string
  h3: string
  h4: string
  /** Newer AWG keys (s3, s4, i1–i5, …) passed through to UAPI verbatim, lowercase names. */
  extra: Record<string, string>
}

/** Public tunnel metadata. Private and preshared keys never appear here — they live only in main. */
export interface Tunnel {
  id: string
  name: string
  endpoint: string
  address: string
  dns: string[]
  mtu?: number
  allowedIps: string[]
  peerPublicKey: string
  keepalive?: number
  awg: AwgParams
}

export interface TunnelStats {
  rxBytes: number
  txBytes: number
  lastHandshakeSec: number
}

export interface TunnelState {
  id: string
  status: TunnelStatus
  error?: string
  stats?: TunnelStats
  /** Epoch ms when the current run of fresh handshakes began; absent until the first one. */
  since?: number
}

export interface AppState {
  tunnels: Tunnel[]
  states: Record<string, TunnelState>
  /** Tunnel currently running (or starting), if any. */
  activeId: string | null
  /** A connect/disconnect is in flight — the UI should not start another one. */
  busy: boolean
  /** The in-flight connect replaces a running tunnel (server switch). */
  switching: boolean
  /**
   * A previous session died without cleaning up (reboot, crash): its DNS override and endpoint route
   * may still be applied although no tunnel is running.
   */
  needsCleanup: boolean
  /**
   * The running tunnel will not recover by itself (its route to the server is lost, or its privileged
   * watcher is gone): why, for the user; reconnecting fixes it. Null when all is well.
   */
  degraded: string | null
  /** Opt-in packet capture and root snapshot on connect. */
  diagnostics: boolean
}

export type ImportResult = { ok: true; tunnel: Tunnel } | { ok: false; error: string }

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogSource = 'app' | 'tunnel'

export interface LogEntry {
  id: number
  /** Epoch milliseconds, stamped when main receives the line. */
  ts: number
  level: LogLevel
  source: LogSource
  message: string
}

/** Which amneziawg-go actually runs the tunnels, for «Об SenAWG» and the journal. */
export interface EngineInfo {
  /** e.g. «amneziawg-go v3.1.20260828», or why it could not be determined. */
  engine: string
  /** Where it comes from: bundled, a system copy in development, or the Windows service. */
  detail: string
  /** Set when the engine is usable but not what a release should ship (a development fallback). */
  warning?: string
}

/** What «Об SenAWG» shows. */
export interface AboutInfo {
  /** This build: «{channel}-{version}-{os}», e.g. release-0.1.0-mac. */
  app: string
  /** «amneziawg-go v3.1.20260828», or why it could not be determined. */
  engine: string
}

export interface AwgApi {
  getState(): Promise<AppState>
  previewLink(link: string): Promise<ImportResult>
  importLink(link: string, name?: string): Promise<ImportResult>
  removeTunnel(id: string): Promise<void>
  connect(id: string): Promise<void>
  disconnect(id: string): Promise<void>
  /** Brings the running tunnel up again from scratch (one admin prompt). */
  reconnect(): Promise<void>
  copyEndpoint(id: string): Promise<void>
  /** Milliseconds to the tunnel's DNS, or null when nothing answered. Meaningful only while connected. */
  ping(id: string): Promise<number | null>
  getAppOptions(): Promise<AppOptions>
  setAutoStart(enabled: boolean): Promise<boolean>
  /**
   * Removes SenAWG behind the administrator prompt, reporting the steps through onUninstallProgress
   * and onUninstallFailed; the application stays open to show them. `keepData`: the servers, keys and
   * settings stay on disk for a later install.
   */
  uninstall(keepData: boolean): Promise<UninstallResult>
  onUninstallProgress(cb: (event: SetupProgress) => void): () => void
  onUninstallFailed(cb: (event: SetupFailure) => void): () => void
  /** «Завершить» after a removal that worked: the application closes for good. */
  finishUninstall(): Promise<void>
  cleanup(): Promise<void>
  setDiagnostics(enabled: boolean): Promise<void>
  getAbout(): Promise<AboutInfo>
  getUiSettings(): Promise<UiSettings>
  setUiSettings(patch: Partial<UiSettings>): Promise<UiSettings>
  onState(cb: (state: AppState) => void): () => void
  getLogs(): Promise<LogEntry[]>
  clearLogs(): Promise<void>
  copyLogs(source: LogSource | 'all'): Promise<void>
  onLogs(cb: (entries: LogEntry[]) => void): () => void
  /** Updates over the air (src/main/update). A stub for now: there is no server to download from. */
  update: UpdateApi
}

/**
 * Where the update is. The main process owns it: it checks, downloads in the background and verifies
 * the signature on its own; the user is asked only once there is something ready to install.
 */
export type UpdateState =
  | { kind: 'idle'; checkedAt: number | null }
  | { kind: 'checking' }
  /** Found with «Обновлять автоматически» off: nothing is downloaded until the user asks. */
  | { kind: 'available'; version: string; notes: string[]; total: number }
  | { kind: 'downloading'; version: string; notes: string[]; received: number; total: number }
  /** `message`: why it is still waiting, after an install that was called off (the prompt was declined). */
  | { kind: 'ready'; version: string; notes: string[]; message?: string }
  | { kind: 'installing'; version: string }
  /**
   * `revoked`: the server no longer serves this copy; `unsupported`: this copy itself is not signed by us,
   * so no update is offered for it at all. A download whose signature does not verify is not a state the
   * user sees: it is thrown away and the next check tries again.
   */
  | { kind: 'failed'; reason: 'network' | 'revoked' | 'unsupported'; message: string }

export interface UpdateApi {
  getUpdate(): Promise<UpdateState>
  checkForUpdate(): Promise<void>
  /** «Скачать обновление»: from `available` only. */
  downloadUpdate(): Promise<void>
  /** Closes the application, installs, and starts it again; a connection comes back by itself. */
  installUpdate(): Promise<void>
  onUpdate(cb: (state: UpdateState) => void): () => void
  /** This is the new version, opened over the old one by a seamless update: the version it came up as. */
  onUpdated(cb: (version: string) => void): () => void
}

/** The switches that belong to the system, not to the application. */
export interface AppOptions {
  /** false on a platform where none of this applies: the tab is not shown at all. */
  supported: boolean
  /** Windows only: elsewhere the application is thrown away the same way it was put there. */
  canUninstall: boolean
  autoStart: boolean
  /** Windows only: the notification-area icon that keeps the connection up with the window closed. */
  canRunInBackground: boolean
}

/** `cancelled`: the administrator prompt was declined, and nothing was touched. */
export type UninstallResult = 'done' | 'failed' | 'cancelled'

/** «install» on a clean machine, «update» when a previous install is registered. */
export type SetupMode = 'install' | 'update'

/** What the setup screen needs to know before anything is pressed. */
export interface SetupInfo {
  mode: SetupMode
  /** Where the express install goes; for an update, where the application already is. */
  defaultPath: string
  /** «beta-0.1.0-win», for the line at the foot of the screen. */
  buildId: string
  /**
   * An update the application started itself («Перезапустить и обновить»): the user has already said yes
   * there, so the screen skips the question and goes straight to work.
   */
  auto?: boolean
  /**
   * A fresh install over servers and keys kept from an earlier one («сохранить серверы и ключи» on
   * removal): the greeting says «С возвращением!» instead of asking for a first key.
   */
  returning?: boolean
  /**
   * The seamless update: this window opens over the application's, shows only the logo, and hands over to
   * the new application when the work is done. No steps, no ring — the person never saw this screen coming.
   */
  seamless?: boolean
  /** The version being installed, for «Обновляем до …» on the seamless update's screen. */
  version?: string
}

/**
 * `cancelled` is the user declining the administrator prompt: not a failure, nothing was touched, and the
 * screen goes back to the choice. A real failure comes through `onFailed` as well.
 */
/** What the first screen of the installer asks besides where. */
export interface SetupOptions {
  /** A shortcut on the desktop, next to the one in the menu. */
  desktopIcon?: boolean
}

export type SetupInstallResult = { ok: true } | { ok: false; cancelled: boolean }

export interface SetupProgress {
  step: number
  state: 'active' | 'done'
}

export interface SetupFailure {
  step: number
  message: string
}

/** The bridge of the setup screen (src/renderer/installer/installer.js documents how it is used). */
export interface AwgSetupApi extends SetupInfo {
  pickFolder(): Promise<string | null>
  install(path: string, options?: SetupOptions): Promise<SetupInstallResult>
  onProgress(cb: (event: SetupProgress) => void): void
  onFailed(cb: (event: SetupFailure) => void): void
  /** The greeting has landed and settled: the application may be laid over the window. */
  entered(): void
}

export const IPC = {
  getState: 'state:get',
  previewLink: 'link:preview',
  importLink: 'link:import',
  removeTunnel: 'tunnel:remove',
  connect: 'tunnel:connect',
  disconnect: 'tunnel:disconnect',
  copyEndpoint: 'tunnel:copy-endpoint',
  ping: 'tunnel:ping',
  getAppOptions: 'app:options',
  setAutoStart: 'app:autostart',
  uninstall: 'app:uninstall',
  uninstallProgress: 'app:uninstall-progress',
  uninstallFailed: 'app:uninstall-failed',
  finishUninstall: 'app:uninstall-finish',
  getUpdate: 'update:get',
  checkForUpdate: 'update:check',
  downloadUpdate: 'update:download',
  installUpdate: 'update:install',
  updateState: 'update:state',
  updated: 'update:done',
  cleanup: 'tunnel:cleanup',
  reconnect: 'tunnel:reconnect',
  setDiagnostics: 'settings:diagnostics',
  getAbout: 'app:about',
  getUiSettings: 'settings:ui-get',
  setUiSettings: 'settings:ui-set',
  stateEvent: 'state:event',
  getLogs: 'logs:get',
  clearLogs: 'logs:clear',
  copyLogs: 'logs:copy',
  logsEvent: 'logs:append',
  setupPickFolder: 'setup:pick-folder',
  setupInstall: 'setup:install',
  setupProgress: 'setup:progress',
  setupFailed: 'setup:failed',
  setupEntered: 'setup:entered'
} as const
