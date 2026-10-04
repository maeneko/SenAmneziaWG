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

/** pywal's colors.json: special background/foreground and color0–color15, all #rrggbb. */
export interface PywalPalette {
  background: string
  foreground: string
  colors: string[]
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
  /** Set when a sen:// master key keeps this server up to date; absent for a vpn:// key. */
  source?: TunnelSource
}

/** Which master key a tunnel belongs to and which of its servers it is. */
export interface TunnelSource {
  kind: 'sen'
  subId: string
  serverId: number
}

/**
 * `ok`: the last exchange worked; `offline`: the server did not answer (the saved config still works);
 * `revoked`: the server no longer knows this device or key, and nothing more is asked of it.
 */
export type SubscriptionStatus = 'ok' | 'offline' | 'revoked'

/** A sen:// master key as the UI sees it: no secrets, no addresses to poll. */
export interface SubscriptionView {
  id: string
  name: string
  status: SubscriptionStatus
  /** The server changed the settings of a running tunnel; they apply on the next connect. */
  pendingRev: boolean
  /** The link had no TLS: the config crosses the network in the clear (signed, but readable). */
  plain: boolean
  /** Epoch ms of the last answer from the server; 0 before the first. */
  checkedAt: number
  /** The MA7 account the link was issued to (`sen://…#ma7_xxxxxx`); it opens «Профиль». */
  login?: string
}

/** The MA7 account's state, as its API numbers it: 0, 1, 2, 3. */
export type ProfileStatus = 'unpaid' | 'active' | 'processing' | 'overdue'

/** «Профиль»: the MA7 account behind a master key. Amounts in rubles. */
export interface Profile {
  login: string
  status: ProfileStatus
  /** Epoch ms the paid period ends; null before the first payment. */
  paidUntil: number | null
  balance: number
  /** What the next month costs, promo codes taken off. */
  monthly: number
  /** Keys the account pays for. */
  keys: number
}

/**
 * What more devices cost now (MA7 POST /api/page/keyquote, calcKeyChange in ma7amnesia's telegram.service.ts):
 * the ones above those already paid for this period are paid for the days left of it, the end date stays.
 * Amounts in rubles.
 */
export interface KeyQuote {
  /** Devices the account has now. */
  current: number
  /** Devices this period is paid for: up to this many come back free until the end date. */
  paid: number
  target: number
  /** One device a month, before promo codes. */
  price: number
  /** Devices above `paid`: the ones the surcharge is for. */
  addKeys: number
  /** addKeys × price, and what promo codes take off it, a month. */
  fullMonthly: number
  discountMonthly: number
  daysLeft: number
  periodDays: number
  /** To pay now, off the balance: (fullMonthly − discountMonthly) × daysLeft / periodDays. */
  amount: number
  /** What a month costs from the end date on, with `target` devices. */
  monthlyNext: number
  balance: number
  /** What the balance lacks for `amount`. */
  shortfall: number
  paidUntil: number | null
  /** The most devices MA7 gives one account. */
  maxKeys: number
}

/** Every count of devices from one more than the account has up to `maxKeys`, priced; empty at the most already. */
export interface KeyQuotes {
  maxKeys: number
  quotes: KeyQuote[]
}

/**
 * «Оплатить с баланса»: the devices are there, and the master key takes that many at once; or MA7 counted another
 * sum than the one shown (a promo code ran out, a day passed, the balance moved) — then nothing is charged and
 * the new quote is shown instead.
 */
export type KeyPurchase =
  | { ok: true; devices: number; charged: number; balance: number | null }
  | { ok: false; quote: KeyQuote; error: string }

/** Where to send the money for the subscription, as MA7 gives it: a transfer by phone number (СБП). */
export interface PaymentDetails {
  bank: string
  phone: string
  /** The name the bank shows before the transfer, to check it goes to the right person. */
  recipient?: string
}

/**
 * A notification on the main screen: from the app itself (a subscription running out) or sent to it
 * (an announcement). `action` opens a section of the app; `dismissible: false` stays until what it is
 * about is dealt with (an overdue payment), and the one who sent it takes it back.
 */
export interface AppNotice {
  id: string
  tone: 'info' | 'success' | 'warn' | 'error'
  /**
   * What comes first, before how new it is: `high` — the subscription (running out, overdue), which the
   * VPN depends on; `normal` — announcements and changes to the key; `low` — confirmations.
   */
  priority: 'high' | 'normal' | 'low'
  title: string
  text?: string
  action?: { label: string; view: 'profile' | 'key' | 'settings' }
  dismissible: boolean
  /** Epoch ms; within a priority, the newest is shown first. */
  at: number
}

/** What a promo code takes off: rubles or percent, off the whole subscription or off each device. */
export interface PromoDiscount {
  kind: 'rubles' | 'percent'
  value: number
  perDevice: boolean
}

export type PromoResult = { ok: true; discount: PromoDiscount } | { ok: false; error: string }

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
  subscriptions: SubscriptionView[]
  /**
   * MA7 accounts on this computer, for «Профиль». A key brings its login, and the account stays when the key
   * is gone (revoked or unbound) — then with no servers at all — until «Выйти».
   */
  accounts: string[]
}

/** How many of a master key's device slots are taken, this computer included. */
export interface KeyBindings {
  used: number
  limit: number
}

/** `bindings`: only for a master key, and only when the server could say. */
export type ImportResult = { ok: true; tunnel: Tunnel; bindings?: KeyBindings } | { ok: false; error: string }

/**
 * What a link shows before it is saved. A sen:// link is only read, not registered (registering takes one
 * of the key's device slots), so it has no server to show yet: `master` instead of `tunnel`.
 */
export type PreviewResult = ImportResult | { ok: true; master: MasterKeyPreview }

/** A device registered with a master key, as the key's server lists them. */
export interface KeyDevice {
  id: number
  name: string
  platform: string
  /** The app's version on that device; empty for an app that did not report one. */
  version: string
  /** Unix seconds. */
  createdAt: number
  /** Unix seconds of its last request to the server; null if it never asked. */
  lastSeen: number | null
  /** This computer. */
  current: boolean
}

/** «Ключ»: who is bound to the master key, and how many more can be. */
export interface KeyDevices {
  limit: number
  devices: KeyDevice[]
}

/** What a sen:// link says about itself before anything is sent. */
export interface MasterKeyPreview {
  name: string
  address: string
  tls: boolean
}

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
  previewLink(link: string): Promise<PreviewResult>
  importLink(link: string, name?: string): Promise<ImportResult>
  removeTunnel(id: string): Promise<void>
  /** Asks the master key's server for the current settings now; resolves once it has answered (or not). */
  refreshSubscription(id: string): Promise<void>
  /** The slots of a pasted sen:// link that are taken, asked before it is added; null when nobody can say. */
  peekKey(link: string): Promise<KeyBindings | null>
  /** The devices bound to the master key; rejects with a message when the server cannot say. */
  getKeyDevices(id: string): Promise<KeyDevices>
  /** «Отвязать это устройство»: the server forgets it, and the key's servers and keys leave this computer. */
  removeSubscription(id: string): Promise<void>
  /** The MA7 account of a login from a master key; rejects with a message when MA7 cannot say. */
  getProfile(login: string): Promise<Profile>
  applyPromo(login: string, code: string): Promise<PromoResult>
  /** «Выйти»: the master keys stop naming this login; the keys and their servers stay. */
  logoutProfile(login: string): Promise<void>
  getPaymentDetails(login: string): Promise<PaymentDetails>
  /** «Подтвердить»: the account is `processing` until an admin finds the transfer. */
  confirmPayment(login: string): Promise<void>
  /**
   * «Устройства»: what each count of devices would cost now, from one more than the account has up to the most MA7
   * gives — one answer, so «+» and «−» need no network. Empty at the most already; rejects with MA7's words (inactive).
   */
  getKeyQuotes(login: string): Promise<KeyQuotes>
  /** Charges `amount` (the sum shown) off the balance and raises the account, and its master key, to `count` devices. */
  buyKeys(login: string, count: number, amount: number): Promise<KeyPurchase>
  /**
   * The balance lacks for the devices: a top-up request to the admins, as the bot's «Пополнить» sends. Only the
   * money goes on the balance when they confirm it; the devices are bought after that, at the sum of that moment.
   */
  requestTopup(login: string, count: number, amount: number): Promise<void>
  /**
   * «Меньше устройств»: who is bound to the account's master key, this computer marked — from the key's own server
   * when this computer has the key, else from MA7 (and then none of them is this one).
   */
  getAccountDevices(login: string): Promise<KeyDevices>
  /** Unbinds another device of the account's master key through MA7; this computer is refused (it goes in «Ключ»). */
  unbindAccountDevice(login: string, deviceId: number): Promise<void>
  /**
   * «Репорт» in the journal, step one: puts the report together — the person's words, the server it is about,
   * and behind their switches the last half hour of the journal and what the device is — and gives it back to be
   * looked over. Rejects when the text is empty or too long.
   */
  prepareReport(login: string, message: string, options: ReportOptions): Promise<ReportPreview>
  /**
   * Step two, «Отправить»: sends the prepared report as it was shown, to MA7's admin panel
   * (POST /api/page/report). Needs the access token, like payment; rejects with MA7's own words.
   */
  sendReport(id: string): Promise<void>
  getNotices(): Promise<AppNotice[]>
  onNotices(cb: (notices: AppNotice[]) => void): () => void
  /** Closed by the person: it does not come back. */
  dismissNotice(id: string): Promise<void>
  /** Asks MA7 for the notices now, not at the next round; resolves once it has answered (or not). */
  refreshNotices(): Promise<void>
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
  /** macOS: the SenAWG service that connects without a password; null where the app does not use one. */
  getMacService(): Promise<MacServiceInfo | null>
  /**
   * macOS: removes the service behind the administrator prompt (the next connection installs it again).
   * Rejects, with a message for the user, while a tunnel is up or when the removal fails.
   */
  removeMacService(): Promise<'done' | 'cancelled'>
  cleanup(): Promise<void>
  setDiagnostics(enabled: boolean): Promise<void>
  getAbout(): Promise<AboutInfo>
  /** pywal's current palette (~/.cache/wal/colors.json), or null when there is none. */
  getPywal(): Promise<PywalPalette | null>
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
  | { kind: 'failed'; reason: 'network' | 'revoked' | 'unsupported'; message: string; /** It broke installing, not checking or downloading. */ installing?: boolean }

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

/** macOS: the launchd service (helper/*_darwin.go) the app connects through. */
export interface MacServiceInfo {
  installed: boolean
  /** Its version, when it answered. */
  version?: string
  /**
   * Whether it is this build's own. false after an update that changed it, until the next connection
   * reinstalls it (with one password); absent when it did not answer.
   */
  current?: boolean
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
  /**
   * The installed copy is this very version (an update the person started by opening the installer again):
   * there is nothing to update, so the screen offers to open it, or to reinstall it over itself.
   */
  alreadyInstalled?: boolean
  /**
   * `--maintenance` (Linux): this is the installed application itself, opened on the same screen to be updated
   * or removed. Nothing to reinstall from, so only «Открыть SenAWG», «Обновить» and «Удалить».
   */
  maintenance?: boolean
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

/**
 * Linux with no polkit agent to ask for the administrator's password (a bare window manager): the setup
 * screen asks instead. `user`: whose password, as polkit names them; `retry`: the last one was wrong.
 */
export interface SetupPasswordRequest {
  user: string
  retry: boolean
}

/** The bridge of the setup screen (src/renderer/installer/installer.js documents how it is used). */
export interface AwgSetupApi extends SetupInfo {
  pickFolder(): Promise<string | null>
  install(path: string, options?: SetupOptions): Promise<SetupInstallResult>
  onProgress(cb: (event: SetupProgress) => void): void
  onFailed(cb: (event: SetupFailure) => void): void
  onPassword(cb: (request: SetupPasswordRequest) => void): void
  /** The password typed, or null for «Отмена», which calls the install off. */
  answerPassword(password: string | null): void
  /** The greeting has landed and settled: the application may be laid over the window. */
  entered(): void
  /** «Открыть SenAWG» over the same version: starts the installed application and closes the installer. */
  openInstalled(): void
  /**
   * «Обновить» on the «уже установлен» screen: checks the site and downloads a newer version, reporting through
   * onUpdateState; a downloaded one is started as an update from the application and this window closes.
   */
  update(): void
  onUpdateState(cb: (state: UpdateState) => void): void
  /** «Удалить»: `awg-helper remove`, as from the application's settings, with the same progress events. */
  uninstall(keepData: boolean): Promise<UninstallResult>
  onUninstallProgress(cb: (event: SetupProgress) => void): void
  onUninstallFailed(cb: (event: SetupFailure) => void): void
  /** «Завершить» after a removal: wipes what was asked to be wiped and closes. */
  finishUninstall(): void
}

/** What goes with a «Репорт» besides the text. */
export interface ReportOptions {
  /** The server the trouble is with; null — not about a server. Main names it, the page only picks. */
  tunnelId: string | null
  /** The journal of the last REPORT_LOGS_WINDOW_MS. */
  withLogs: boolean
  /** The system, its version and architecture (main/systemInfo.ts). */
  withDevice: boolean
}

/** A «Репорт» as it will be sent: what the review step shows, field by field. */
export interface ReportPreview {
  /** «Отправить» sends the report by this id — the very one shown, not one put together again. */
  id: string
  message: string
  /** «Name (address)»; null — not about a server. */
  server: string | null
  appVersion: string
  /** Null when the device is left out. */
  systemInfo: string | null
  /** The journal lines as they go; null when left out or empty. */
  logs: string | null
  logEntries: number
}

/** How far back the journal attached to a «Репорт» goes: the half hour in which the trouble happened. */
export const REPORT_LOGS_WINDOW_MS = 30 * 60_000

/** The longest «Репорт» text MA7 takes (ma7amnesia api/src/services/reports.service.ts: MESSAGE_MAX). */
export const REPORT_MESSAGE_MAX = 4000
/** How much of the journal goes with a report: its tail, as MA7 keeps it (reports.service.ts: LOGS_MAX). */
export const REPORT_LOGS_MAX = 300_000

export const IPC = {
  getState: 'state:get',
  previewLink: 'link:preview',
  importLink: 'link:import',
  removeTunnel: 'tunnel:remove',
  refreshSubscription: 'sub:refresh',
  peekKey: 'link:peek',
  getKeyDevices: 'sub:devices',
  removeSubscription: 'sub:remove',
  getProfile: 'profile:get',
  applyPromo: 'profile:promo',
  logoutProfile: 'profile:logout',
  getPaymentDetails: 'profile:payment',
  confirmPayment: 'profile:paid',
  getKeyQuotes: 'profile:keyQuotes',
  buyKeys: 'profile:buyKeys',
  requestTopup: 'profile:topup',
  getAccountDevices: 'profile:devices',
  unbindAccountDevice: 'profile:unbindDevice',
  prepareReport: 'report:prepare',
  sendReport: 'report:send',
  getNotices: 'notices:get',
  noticesEvent: 'notices:event',
  dismissNotice: 'notices:dismiss',
  refreshNotices: 'notices:refresh',
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
  getMacService: 'mac-service:get',
  removeMacService: 'mac-service:remove',
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
  getPywal: 'pywal:get',
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
  setupEntered: 'setup:entered',
  setupPassword: 'setup:password',
  setupPasswordAnswer: 'setup:password-answer',
  setupOpenInstalled: 'setup:open-installed',
  setupUpdate: 'setup:update',
  setupUpdateState: 'setup:update-state',
  setupUninstall: 'setup:uninstall',
  setupFinishUninstall: 'setup:uninstall-finish'
} as const
