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

/** Which amneziawg-go actually runs the tunnels, for «Об AmnesiaWG» and the journal. */
export interface EngineInfo {
  /** e.g. «amneziawg-go v3.1.20260828», or why it could not be determined. */
  engine: string
  /** Where it comes from: bundled, a system copy in development, or the Windows service. */
  detail: string
  /** Set when the engine is usable but not what a release should ship (a development fallback). */
  warning?: string
}

/** What «Об AmnesiaWG» shows. */
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
  copyEndpoint(id: string): Promise<void>
  /** Milliseconds to the tunnel's DNS, or null when nothing answered. Meaningful only while connected. */
  ping(id: string): Promise<number | null>
  cleanup(): Promise<void>
  setDiagnostics(enabled: boolean): Promise<void>
  getAbout(): Promise<AboutInfo>
  getUiSettings(): Promise<UiSettings>
  setUiSettings(patch: Partial<UiSettings>): Promise<UiSettings>
  quit(): Promise<void>
  onState(cb: (state: AppState) => void): () => void
  getLogs(): Promise<LogEntry[]>
  clearLogs(): Promise<void>
  copyLogs(source: LogSource | 'all'): Promise<void>
  onLogs(cb: (entries: LogEntry[]) => void): () => void
}

/** «install» on a clean machine, «update» when a previous install is registered. */
export type SetupMode = 'install' | 'update'

/** What the setup screen needs to know before anything is pressed. */
export interface SetupInfo {
  mode: SetupMode
  /** Where the express install goes; for an update, where the application already is. */
  defaultPath: string
  /** «beta-0.1.0-win», for the line at the foot of the screen. */
  buildId: string
}

/**
 * `cancelled` is the user declining the administrator prompt: not a failure, nothing was touched, and the
 * screen goes back to the choice. A real failure comes through `onFailed` as well.
 */
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
  install(path: string): Promise<SetupInstallResult>
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
  cleanup: 'tunnel:cleanup',
  setDiagnostics: 'settings:diagnostics',
  getAbout: 'app:about',
  getUiSettings: 'settings:ui-get',
  setUiSettings: 'settings:ui-set',
  quit: 'app:quit',
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
