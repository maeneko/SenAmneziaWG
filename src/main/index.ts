import { app, BrowserWindow, clipboard, ipcMain, nativeTheme, net, shell, WebContentsView, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { BETA_NOTICE } from '../shared/notices'
import { IPC, REPORT_MESSAGE_MAX, type ReportOptions, type ReportPreview, type AboutInfo, type AppNotice, type ImportResult, type LogSource, type PreviewResult, type SetupInfo } from '../shared/types'
import { AWG_VERSION_LABEL, detectAwgVersion } from '../shared/awgVersion'
import { VpnLinkError } from './config/vpnLink'
import { parseVpnLink } from './config/wgConfig'
import { SenLinkError, isSenLink } from './config/senLink'
import { senRequest } from './sen/client'
import { deviceIdFor, deviceName } from './sen/device'
import { SenManager } from './sen/manager'
import { ma7Client, type Ma7Report } from './ma7'
import { buildReport } from './report'
import { Ma7Notices } from './ma7Notices'
import { buildId } from './buildId'
import { describeSystem } from './systemInfo'
import { describeDevice, startCpuSampler } from './deviceInfo'
import { Logger, RepeatFilter, formatEntries, parseDaemonLine } from './logger'
import { readPywal } from './pywal'
import { loadSettings, loadUiSettings, saveSettings } from './settings'
import { resolveDns, sanitizeUiSettings } from '../shared/uiSettings'
import { listTunnels, removeTunnel, saveTunnel, useKeyVault } from './store'
import type { Backend } from './tunnel/backend'
import { createBackend } from './tunnel/createBackend'
import { readMacService, removeMacService, SOCKET_PATH as MAC_SOCKET_PATH } from './tunnel/macos/service'
import { usesService } from './tunnel/macosBackend'
import { HelperClient } from './tunnel/windows/helperClient'
import { TunnelManager } from './tunnel/manager'
import { measurePing } from './tunnel/ping'
import { canRunInBackground, readAppOptions, writeAutoStart } from './appOptions'
import { createTray, type AppTray } from './tray'
import { createUninstaller } from './uninstall'
import { startUpdater } from './update'
import { registerSetupIpc } from './setup'
import {
  defaultInstallDir,
  isSetupMode,
  isMaintenanceMode,
  isUpdateFromApp,
  readInstalledDir,
  readInstalledVersion,
  seamlessOf,
  MAINTENANCE_FLAG,
  updatedOf,
  waitForExit,
  waitPidOf
} from './setup/mode'
import { writeMarker } from './update/handoff'

// design.md: surface (light) / surface (dark) — avoids a white flash before the renderer paints.
const BG_LIGHT = '#faf6f0'
const BG_DARK = '#1a1611'

const logger = new Logger()
let window: BrowserWindow | null = null
/**
 * Setup mode only: the application, loaded behind the setup screen and laid over the window once the
 * screen has turned into its first page (see showApp).
 */
let appView: WebContentsView | null = null
let manager: TunnelManager
let sen: SenManager
let ma7Notices: Ma7Notices | null = null
let backend: Backend
let tray: AppTray | null = null
/** Set by before-quit: from then on a close is a close, whoever asked for the quit (tray, update, removal). */
let quitting = false
/**
 * The window shows the application, not the setup screen: only then does closing it leave the process
 * running. During an install a close still means «stop».
 */
let appShown = false

/** Where the application's pushes go: its window, or — after a setup — the view laid over that window. */
const ui = (): WebContents | undefined => (appView ?? window)?.webContents

/** `--maintenance` (Linux): the installed application opens as the installer's «уже установлен» screen. */
const maintenanceMode = isMaintenanceMode(process.argv, process.platform, app.isPackaged)
const setupMode = isSetupMode(process.argv, process.env) || maintenanceMode

/** Windows and Linux: closing the window hides it behind the notification-area icon (Настройки → «Работать в фоне»). */
const backgroundOn = (): boolean => canRunInBackground() && loadSettings().runInBackground

/** The square Windows icon (build/icon-win.png) or the regular one on Linux, shipped next to the helper
 * so the tray can use it without asking the desktop to already know the app (see docs/linux.md on
 * GNOME needing an AppIndicator extension for the tray icon to show up at all). */
const trayIconFile = (): string => (process.platform === 'win32' ? 'icon-win.png' : 'icon.png')
const winIcon = (): string =>
  app.isPackaged
    ? join(process.resourcesPath, process.platform === 'win32' ? 'win' : 'linux', trayIconFile())
    : join(__dirname, '../../build', trayIconFile())

const backgroundColor = (): string => (nativeTheme.shouldUseDarkColors ? BG_DARK : BG_LIGHT)

// The renderer is a single local page: never navigate away or open new windows inside the app.
function lockDown(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (e) => e.preventDefault())
}

/** `page`: the application, or the setup screen (a second entry of the renderer build). */
function loadPage(contents: WebContents, page: 'app' | 'setup', query?: Record<string, string>): void {
  const dev = process.env['ELECTRON_RENDERER_URL']
  if (dev) {
    const url = new URL(page === 'setup' ? 'installer/index.html' : '', dev.endsWith('/') ? dev : `${dev}/`)
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v)
    void contents.loadURL(url.toString())
    return
  }
  const file = page === 'setup' ? '../renderer/installer/index.html' : '../renderer/index.html'
  void contents.loadFile(join(__dirname, file), query ? { query } : undefined)
}

const PRELOAD = (): string => join(__dirname, '../preload/index.js')

/** `bounds`: where to open — the window it replaces, so the swap does not move anything. */
function createWindow(
  setup?: SetupInfo,
  bounds?: Electron.Rectangle,
  opts: { hidden?: boolean; query?: Record<string, string> } = {}
): void {
  const win = new BrowserWindow({
    // Phone-sized by default: the single-column layout (design.md Part III §1); it can still be widened.
    width: 420,
    height: 780,
    ...bounds,
    minWidth: 360,
    minHeight: 520,
    show: false,
    backgroundColor: backgroundColor(),
    // macOS keeps its traffic lights over the page (the renderer reserves a strip for them); elsewhere the native frame stays.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    ...(canRunInBackground() ? { icon: winIcon() } : {}),
    webPreferences: {
      preload: PRELOAD(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The setup bridge is for this window alone: the preload exposes it only when it finds this argument.
      additionalArguments: setup ? [`--awg-setup=${Buffer.from(JSON.stringify(setup)).toString('base64')}`] : []
    }
  })

  window = win
  appView = null
  // Again once it exists: on a display scaled differently from the main one, Windows sizes a window created
  // with bounds for the wrong scale, and the replacement comes up a few pixels off the one it replaces.
  if (bounds) win.setBounds(bounds)
  // The seamless update's window stays hidden until the new version is staged (SeamlessHost.staged).
  win.once('ready-to-show', () => {
    if (!opts.hidden) win.show()
  })
  win.on('close', (e) => {
    if (quitting || window !== win || !appShown || !backgroundOn()) return
    e.preventDefault()
    win.hide()
    tray?.notifyHidden()
  })
  win.on('closed', () => {
    if (window !== win) return // replaced by another window, which is the one that counts now
    window = null
    appView = null
  })
  win.on('resize', layoutAppView)

  lockDown(win.webContents)
  loadPage(win.webContents, setup ? 'setup' : 'app', opts.query)
}

function layoutAppView(): void {
  if (!window || !appView) return
  const [width, height] = window.getContentSize()
  appView.setBounds({ x: 0, y: 0, width, height })
}

/**
 * Setup mode, after the service is running: builds the application in a view that is not on screen yet.
 * `?from=setup` makes its first page appear already assembled — the setup screen has just played that
 * greeting's entrance, and playing it a second time would be seen.
 */
async function prepareApp(returning: boolean, arrive = false): Promise<void> {
  if (!window) return
  startApp()
  await buildAppView(true, returning, arrive)
}

/**
 * `init`: a fresh application, whose manager has yet to learn the state of the tunnel. `returning`: the
 * servers were kept from an earlier install, so the first page is «С возвращением!» (SetupInfo.returning).
 * `arrive`: the seamless update, whose screen ends with the logo in the header's corner.
 */
async function buildAppView(init: boolean, returning = false, arrive = false): Promise<void> {
  if (!window) return
  const view = new WebContentsView({
    webPreferences: { preload: PRELOAD(), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  view.setBackgroundColor(backgroundColor())
  lockDown(view.webContents)
  appView = view
  const loaded = new Promise<void>((resolve) => view.webContents.once('did-finish-load', () => resolve()))
  // `arrive`: the seamless update's logo has flown to the header's corner; the page shows only that logo
  // until IPC.updated brings the rest in around it (App.tsx).
  loadPage(view.webContents, 'app', { from: 'setup', ...(returning ? { back: '1' } : {}), ...(arrive ? { arrive: '1' } : {}) })
  await loaded
  if (init) void manager.init()
  // The page has loaded, but its first screen appears once the state has arrived.
  for (let i = 0; i < 100; i++) {
    const ready = await view.webContents
      .executeJavaScript(`Boolean(document.querySelector('.app')) && !document.querySelector('.app[aria-busy]')`)
      .catch(() => false)
    if (ready) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function showApp(): void {
  if (!window || !appView) return
  appShown = true
  window.contentView.addChildView(appView)
  layoutAppView()
  appView.webContents.focus()
}

/** The seamless update: the application it replaces is watching for this; failing to write it only costs that one its timeout. */
function tellApplication(dir: string, marker: 'shown' | 'cancelled' | 'failed', text = ''): void {
  try {
    writeMarker(dir, marker, text)
  } catch (err) {
    logger.error(`Не удалось сообщить приложению об обновлении: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * The new version is on screen where the old one was: it says so (a note at the foot, the main screen
 * rising in) and connects again to the server that was connected, which the update had dropped.
 */
function resumeAfterUpdate(reconnectId: string | null, version = app.getVersion()): void {
  logger.info(`Обновлено до ${version}`)
  // A frame or so after the view is laid over the window, so its entrance is painted where it can be seen.
  // macOS has no setup screen, so no view: the application's page is the window's own.
  const contents = (appView ?? window)?.webContents
  setTimeout(() => contents?.send(IPC.updated, version), 50)
  if (!reconnectId || !listTunnels().some((t) => t.id === reconnectId)) return
  manager.connect(reconnectId).catch((err: unknown) => {
    logger.error(`Не удалось подключиться после обновления: ${err instanceof Error ? err.message : String(err)}`)
  })
}

let updateScreenIpc = false

/**
 * `npm run dev` with AWG_UPDATE_SIMULATE, «Перезапустить и обновить»: the update screen as the downloaded
 * installer will show it — in place of the window, already at work, then the application again. The real
 * one is a new process with new files; here nothing is replaced, so this process plays both parts.
 */
function playUpdateScreen(version: string): void {
  // macOS has no update screen (update/mac.ts); AWG_UPDATE_DEMO=installer shows the Windows and Linux one there too.
  if (process.platform === 'darwin' && process.env['AWG_UPDATE_DEMO'] !== 'installer') return playMacRelaunch(version)
  const old = window
  // The real update is seamless; AWG_UPDATE_LEGACY=1 plays the older one, with its steps and ring.
  const seamless = process.env['AWG_UPDATE_LEGACY'] !== '1'
  const info: SetupInfo = {
    mode: 'update',
    defaultPath: defaultInstallDir(),
    buildId: buildId(app.getVersion()),
    auto: true,
    seamless,
    version: app.getVersion()
  }
  if (!updateScreenIpc) {
    registerSetupIpc({
      info,
      window: () => window,
      prepareApp: () => buildAppView(false, false, seamless),
      showApp: () => {
        showApp()
        if (seamless) resumeAfterUpdate(null)
      }
    })
    updateScreenIpc = true
  }
  appShown = false
  createWindow(info, old?.getBounds())
  // destroy, not close: a close would be taken for the user's and only hide the old window.
  old?.destroy()
}

/**
 * `npm run dev` with AWG_UPDATE_SIMULATE on macOS: «Перезапустить и обновить» as update/mac.ts plays it.
 * The new version is copied beside the old one while the card says «Установка…»; the window goes; Launch
 * Services opens the new copy a moment later where the old window stood, and it says «Обновлено до …».
 * Nothing is replaced and the process stays, so the tunnel is not dropped and nothing reconnects.
 */
function playMacRelaunch(version: string): void {
  const STAGING_MS = 1500 // hdiutil and ditto of a real image take a few seconds
  const GAP_MS = 1200 // from the old process quitting to the new window being painted
  setTimeout(() => {
    const old = window
    if (!old) return
    const maximized = old.isMaximized()
    const bounds = maximized ? old.getNormalBounds() : old.getBounds()
    // Hidden, not destroyed: with no window left the application would quit for real.
    old.hide()
    setTimeout(() => {
      createWindow(undefined, bounds)
      const page = window?.webContents
      page?.once('did-finish-load', () => resumeAfterUpdate(null, version))
      if (maximized) window?.once('ready-to-show', () => window?.maximize())
      old.destroy()
    }, GAP_MS)
  }, STAGING_MS)
}

function parse(link: string, name?: string): PreviewResult {
  try {
    if (isSenLink(link)) return { ok: true, master: sen.preview(link) }
    return { ok: true, tunnel: parseVpnLink(link, name).tunnel }
  } catch (err) {
    if (err instanceof VpnLinkError || err instanceof SenLinkError) return { ok: false, error: err.message }
    return { ok: false, error: 'Не удалось разобрать ссылку' }
  }
}

/**
 * The notices on the main screen: the beta one while there is a «Профиль», a master key the server revoked
 * (until the app restarts: the key itself is gone by then), and what MA7's notice center says to each account —
 * each until it is closed.
 */
function notices(): AppNotice[] {
  const accounts = sen.accounts()
  const beta = accounts.length ? [BETA_NOTICE] : []
  const revoked = sen.revoked().map(
    (k): AppNotice => ({
      id: `sen-revoked-${k.id}`,
      tone: 'error',
      priority: 'high',
      title: `Мастер-ключ «${k.name}» отозван`,
      text: accounts.length
        ? 'Его серверы убраны с компьютера. Если подписка оплачена, получите новый ключ в Telegram-боте MA7.'
        : 'Его серверы убраны с компьютера. Чтобы снова подключиться, нужен новый ключ.',
      ...(accounts.length ? { action: { label: 'Профиль', view: 'profile' as const } } : {}),
      dismissible: true,
      at: k.at
    })
  )
  return [...revoked, ...(ma7Notices?.list() ?? []), ...beta].filter((n) => !loadSettings().dismissedNotices.includes(n.id))
}

function registerIpc(): void {
  const updater = startUpdater({
    send: (channel, state) => ui()?.send(channel, state),
    log: (level, message) => logger[level](message),
    automatic: () => loadSettings().autoUpdate,
    playUpdateScreen,
    // Where the window really is: getBounds, not getNormalBounds — a window snapped to half the screen has
    // «normal» bounds from before it was snapped, and the new window would open there instead. A maximized one
    // passes its restored size and is maximized again on the other side.
    windowState: () =>
      window
        ? window.isMaximized()
          ? { bounds: window.getNormalBounds(), maximized: true }
          : { bounds: window.getBounds(), maximized: false }
        : null,
    activeTunnelId: () => manager.snapshot().activeId
  })

  ipcMain.handle(IPC.getState, () => manager.snapshot())
  ipcMain.handle(IPC.previewLink, (_e, link: string) => parse(link))

  ipcMain.handle(IPC.importLink, async (_e, link: string, name?: string): Promise<ImportResult> => {
    try {
      if (isSenLink(link)) {
        const { tunnel, bindings } = await sen.import(link)
        ui()?.send(IPC.stateEvent, manager.snapshot())
        return { ok: true, tunnel, bindings }
      }
      const parsed = parseVpnLink(link, name)
      const place = await saveTunnel(parsed)
      logger.info(
        `Добавлен сервер «${parsed.tunnel.name}» (${parsed.tunnel.endpoint}, ${AWG_VERSION_LABEL[detectAwgVersion(parsed.tunnel.awg)]})`
      )
      if (place === 'service') {
        logger.info('Хранилище ключей системы недоступно — ключи сохранены в службе SenAWG (доступны только root)')
      }
      ui()?.send(IPC.stateEvent, manager.snapshot())
      return { ok: true, tunnel: parsed.tunnel }
    } catch (err) {
      if (err instanceof VpnLinkError) return { ok: false, error: err.message }
      return { ok: false, error: err instanceof Error ? err.message : 'Не удалось сохранить туннель' }
    }
  })

  ipcMain.handle(IPC.removeTunnel, async (_e, id: string) => {
    if (manager.isActive(id)) throw new Error('Сначала отключите туннель')
    const source = listTunnels().find((t) => t.id === id)?.source
    // A card of a master key cannot be told apart from the key: the next refresh would bring it back.
    if (source) return sen.removeSubscription(source.subId)
    const name = listTunnels().find((t) => t.id === id)?.name
    await removeTunnel(id).catch((err: unknown) => {
      // The server is gone from the list already; only the service's copy of its keys is left behind.
      logger.warn(`Не удалось удалить ключи из службы SenAWG: ${err instanceof Error ? err.message : String(err)}`)
    })
    logger.info(`Удалён сервер «${name ?? id}»`)
    manager.forget(id)
  })

  ipcMain.handle(IPC.refreshSubscription, async (_e, id: string) => {
    await sen.refresh(id, { force: false })
  })

  ipcMain.handle(IPC.peekKey, (_e, link: string) => (isSenLink(link) ? sen.peek(link).catch(() => null) : null))
  ipcMain.handle(IPC.getKeyDevices, (_e, id: string) => sen.devices(id))
  ipcMain.handle(IPC.removeSubscription, (_e, id: string) => sen.removeSubscription(id))

  // «Профиль»: MA7 is asked only about the accounts this computer's master keys were issued to.
  const ma7 = ma7Client({ fetch: net.fetch as typeof fetch })
  const account = (login: unknown): string => {
    if (typeof login === 'string' && sen.accounts().includes(login)) return login
    throw new Error('Этот аккаунт не добавлен в приложение')
  }
  ipcMain.handle(IPC.getProfile, (_e, login: unknown) => ma7.profile(account(login)))
  ma7Notices = new Ma7Notices({
    accounts: () => sen.accounts(),
    fetch: (login) => ma7.notices(login),
    dismissed: () => loadSettings().dismissedNotices,
    forget: (ids) => saveSettings({ dismissedNotices: loadSettings().dismissedNotices.filter((id) => !ids.includes(id)) }),
    changed: () => ui()?.send(IPC.noticesEvent, notices()),
    log: (level, message) => logger[level](message)
  })
  ma7Notices.start()
  app.on('browser-window-focus', () => ma7Notices?.poke())
  app.on('before-quit', () => ma7Notices?.stop())
  ipcMain.handle(IPC.logoutProfile, (_e, login: unknown) => sen.logout(account(login)))
  ipcMain.handle(IPC.applyPromo, (_e, login: unknown, code: unknown) => {
    const text = typeof code === 'string' ? code.trim() : ''
    if (!text || text.length > 64) return { ok: false, error: 'Введите промокод' }
    return ma7.promo(account(login), text)
  })
  // Notifications on the main screen: the beta one, a revoked key, and MA7's notice center (announcements, the
  // subscription running out or overdue, a confirmed payment — ma7Notices.ts). A closed one is remembered and
  // does not come back.
  // TODO: a new device on the master key, its device limit lowered — and a switch for each kind in the settings.
  ipcMain.handle(IPC.getNotices, () => notices())
  ipcMain.handle(IPC.refreshNotices, () => ma7Notices?.refresh())
  ipcMain.handle(IPC.dismissNotice, (_e, id: unknown) => {
    const dismissed = loadSettings().dismissedNotices
    if (typeof id !== 'string' || !notices().some((n) => n.id === id && n.dismissible)) return
    saveSettings({ dismissedNotices: [...dismissed, id] })
    ui()?.send(IPC.noticesEvent, notices())
  })
  ipcMain.handle(IPC.getPaymentDetails, (_e, login: unknown) => ma7.payment(account(login)))
  ipcMain.handle(IPC.confirmPayment, async (_e, login: unknown) => {
    await ma7.paid(account(login))
    logger.info('Отправлена заявка на подтверждение оплаты MA7')
  })
  // «Устройства» in «Профиль»: more devices on the account and its master key, paid for the days left.
  const deviceCount = (count: unknown): number => {
    if (typeof count === 'number' && Number.isInteger(count) && count >= 1 && count <= 100) return count
    throw new Error('Неверное число устройств')
  }
  const rubles = (amount: unknown): number => {
    if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) return amount
    throw new Error('Неверная сумма')
  }
  ipcMain.handle(IPC.getKeyQuote, (_e, login: unknown, count: unknown) => ma7.keyQuote(account(login), deviceCount(count)))
  ipcMain.handle(IPC.buyKeys, async (_e, login: unknown, count: unknown, amount: unknown) => {
    const result = await ma7.buyKeys(account(login), deviceCount(count), rubles(amount))
    if (result.ok) logger.info(`MA7: устройств стало ${result.devices}, списано ${result.charged} ₽`)
    return result
  })
  ipcMain.handle(IPC.requestTopup, async (_e, login: unknown, count: unknown, amount: unknown) => {
    await ma7.topup(account(login), deviceCount(count), rubles(amount))
    logger.info('Отправлена заявка на пополнение баланса MA7 под устройства')
  })
  // «Репорт» in the journal, in two steps. «Далее» puts the report together (main/report.ts) and keeps it;
  // «Отправить» sends that very report — the one the person looked over, not one put together again with a few
  // more journal lines. One at a time: a new «Далее» replaces it.
  let preparedReport: { id: string; login: string; report: Ma7Report } | null = null
  ipcMain.handle(IPC.prepareReport, async (_e, login: unknown, message: unknown, options: unknown): Promise<ReportPreview> => {
    const text = typeof message === 'string' ? message.trim() : ''
    if (!text) throw new Error('Опишите, что случилось')
    if (text.length > REPORT_MESSAGE_MAX) throw new Error(`Текст — до ${REPORT_MESSAGE_MAX} символов`)
    const o = (options && typeof options === 'object' ? options : {}) as Partial<Record<keyof ReportOptions, unknown>>
    // The page sends only the server's id; its name and address are taken from the saved tunnels.
    const tunnel = typeof o.tunnelId === 'string' ? listTunnels().find((t) => t.id === o.tunnelId) : undefined
    const { report, logEntries } = buildReport({
      message: text,
      tunnel,
      entries: logger.list(),
      now: Date.now(),
      appVersion: buildId(app.getVersion()),
      // Read only when it goes: the engine is asked of the backend, and that takes a moment.
      systemInfo:
        o.withDevice === true
          ? await describeDevice(async () => {
              const info = await backend.describe()
              return `${info.engine} — ${info.detail}`
            })
          : '',
      withLogs: o.withLogs === true,
      withDevice: o.withDevice === true
    })
    const id = randomUUID()
    preparedReport = { id, login: account(login), report }
    return { id, ...report, logEntries }
  })
  ipcMain.handle(IPC.sendReport, async (_e, id: unknown) => {
    const prepared = preparedReport
    if (!prepared || prepared.id !== id) throw new Error('Репорт устарел — нажмите «Назад» и проверьте его ещё раз')
    await ma7.report(prepared.login, prepared.report)
    if (preparedReport?.id === id) preparedReport = null
    logger.info(`Отправлен репорт MA7${prepared.report.logs ? ' с журналом' : ''}`)
  })

  ipcMain.handle(IPC.connect, (_e, id: string) => {
    saveSettings({ lastTunnelId: id })
    return manager.connect(id)
  })
  ipcMain.handle(IPC.disconnect, (_e, id: string) => manager.disconnect(id))
  ipcMain.handle(IPC.cleanup, () => manager.cleanup())
  ipcMain.handle(IPC.reconnect, () => manager.reconnect())
  ipcMain.handle(IPC.setDiagnostics, (_e, enabled: boolean) => {
    saveSettings({ diagnostics: enabled === true })
    logger.info(enabled ? 'Диагностика подключения включена (со следующего подключения)' : 'Диагностика подключения выключена')
    ui()?.send(IPC.stateEvent, manager.snapshot())
  })

  // «Об SenAWG» shows this, so a failure is an answer too, not an error dialog.
  ipcMain.handle(IPC.getAbout, async (): Promise<AboutInfo> => {
    const info = { app: buildId(app.getVersion()) }
    try {
      return { ...info, engine: (await backend.describe()).engine }
    } catch (err) {
      return { ...info, engine: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.getPywal, () => readPywal())
  ipcMain.handle(IPC.getUiSettings, () => loadUiSettings())
  ipcMain.handle(IPC.setUiSettings, (_e, patch: unknown) => {
    const clean = sanitizeUiSettings(patch)
    const wasAutomatic = loadSettings().autoUpdate
    saveSettings(clean)
    if (clean.theme) {
      nativeTheme.themeSource = clean.theme
      appView?.setBackgroundColor(backgroundColor())
    }
    if (typeof clean.runInBackground === 'boolean') tray?.setEnabled(backgroundOn())
    // Switched back on: catch up now instead of at the next scheduled check, hours away.
    if (clean.autoUpdate === true && !wasAutomatic) void updater.check()
    return loadUiSettings()
  })

  // Electron 44's clipboard API is promise-based: await it so a failure reaches the renderer.
  ipcMain.handle(IPC.copyEndpoint, async (_e, id: string) => {
    const tunnel = listTunnels().find((t) => t.id === id)
    if (tunnel) await clipboard.writeText(tunnel.endpoint)
  })

  // Only while the tunnel is up: with it down the query would go out over the plain connection and
  // the number would be the latency of the provider, not of the server.
  ipcMain.handle(IPC.ping, async (_e, id: string): Promise<number | null> => {
    if (manager.snapshot().activeId !== id) return null
    const tunnel = listTunnels().find((t) => t.id === id)
    return tunnel ? measurePing(tunnel.dns) : null
  })

  ipcMain.handle(IPC.getLogs, () => logger.list())
  ipcMain.handle(IPC.clearLogs, () => logger.clear())
  ipcMain.handle(IPC.copyLogs, async (_e, source: LogSource | 'all') => {
    await clipboard.writeText(formatEntries(logger.list(source)))
  })

  ipcMain.handle(IPC.getAppOptions, () => readAppOptions())
  ipcMain.handle(IPC.setAutoStart, (_e, enabled: boolean) => writeAutoStart(enabled === true))
  const uninstaller = createUninstaller({
    send: (channel, payload) => ui()?.send(channel, payload),
    pause: () => manager.pause(),
    resume: () => manager.resume(),
    log: (level, message) => logger[level](message)
  })
  ipcMain.handle(IPC.uninstall, (_e, keepData: unknown) => uninstaller.start(keepData !== false))
  ipcMain.handle(IPC.finishUninstall, () => uninstaller.finish())

  // macOS: the service connections go through (tunnel/macos/service.ts), and the way to take it off.
  const macService = process.platform === 'darwin' && usesService(app.isPackaged)
  const appResources = (): string => (app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources'))
  ipcMain.handle(IPC.getMacService, () => (macService ? readMacService(appResources(), new HelperClient(MAC_SOCKET_PATH)) : null))
  ipcMain.handle(IPC.removeMacService, async () => {
    if (!macService) throw new Error('Службы SenAWG здесь нет')
    // Taking the service off takes the tunnel down with it (awg.sh down), behind the manager's back.
    if (manager.snapshot().activeId !== null) throw new Error('Сначала отключите VPN')
    const result = await removeMacService(appResources())
    logger.info(result === 'done' ? 'Служба SenAWG удалена' : 'Удаление службы отменено')
    return result
  })

  ipcMain.handle(IPC.getUpdate, () => updater.get())
  ipcMain.handle(IPC.checkForUpdate, () => updater.check())
  ipcMain.handle(IPC.downloadUpdate, () => updater.download())
  ipcMain.handle(IPC.installUpdate, () => updater.install())
}

// Two windows would mean two UIs steering one tunnel. The update screen started by «Перезапустить и
// обновить» comes up while that application is still closing, and must not take it for a second window.
const primary = waitForExit(setupMode ? waitPidOf(process.argv) : null).then(async () => {
  let got = app.requestSingleInstanceLock()
  // `--maintenance` over a running application: that one is asked to close (second-instance below) and given
  // a few seconds to let go of the lock — removing it under itself would only start its service again.
  for (let i = 0; !got && maintenanceMode && i < 25; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    got = app.requestSingleInstanceLock()
  }
  if (!got) app.quit()
  return got
})
app.on('second-instance', (_e, argv) => {
  if (!setupMode && argv.includes(MAINTENANCE_FLAG)) {
    app.releaseSingleInstanceLock()
    app.quit()
    return
  }
  showWindow()
})

/** From the tray, or a second launch: the window back from wherever it went. */
function showWindow(): void {
  if (!window) {
    if (!setupMode) createWindow()
    return
  }
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

/** One line in the journal at start-up: which daemon the tunnels will actually run on. */
async function reportEngine(): Promise<void> {
  try {
    const info = await backend.describe()
    logger.info(`${info.engine} — ${info.detail}`)
    if (info.warning) logger.warn(info.warning)
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err))
  }
}

/** The application proper: the tunnel manager behind the backend of this platform, and the IPC the page talks to. */
function startApp(): void {
  // «Репорт» says how loaded the processor was over the last half hour: that needs readings from before it.
  startCpuSampler()
  const resources = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  // Packaged builds get build/icon.png through electron-builder; in development the Dock would show Electron's.
  // Cosmetic only: a missing or unreadable file must never stop the window from opening.
  if (!app.isPackaged) {
    try {
      app.dock?.setIcon(join(__dirname, '../../build/icon.png'))
    } catch {
      /* keep Electron's icon */
    }
  }
  const repeats = new RepeatFilter()
  backend = createBackend({
    resources,
    userData: app.getPath('userData'),
    packaged: app.isPackaged,
    logger,
    diagnostics: () => loadSettings().diagnostics,
    dnsFor: (tunnel) => resolveDns(tunnel.dns, loadSettings()),
    daemonLines: (lines) => {
      logger.addMany(repeats.filter(lines.map(parseDaemonLine)))
      manager.daemonLines(lines)
    }
  })
  useKeyVault(backend.vault ?? null)
  if (canRunInBackground()) {
    tray = createTray({
      icon: winIcon(),
      show: showWindow,
      disconnect: (id) =>
        void manager.disconnect(id).catch((err) => logger.error(err instanceof Error ? err.message : String(err))),
      quit: () => app.quit()
    })
    tray.setEnabled(backgroundOn())
  }
  sen = new SenManager({
    request: senRequest,
    now: Date.now,
    version: app.getVersion(),
    platform: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
    deviceId: deviceIdFor,
    deviceName,
    serviceSign: backend.signSen,
    tunnels: {
      isActive: (id) => manager.isActive(id),
      connect: (id) => manager.connect(id),
      disconnect: (id) => manager.disconnect(id),
      reconnect: () => manager.reconnect(),
      forget: (id) => manager.forget(id)
    },
    log: logger,
    changed: () => {
      ui()?.send(IPC.stateEvent, manager.snapshot())
      // An account added or gone: the beta notice comes or goes with «Профиль»; a key revoked brings its own.
      ui()?.send(IPC.noticesEvent, notices())
      // A new account has nothing from MA7 yet: ask now rather than in a quarter of an hour.
      ma7Notices?.poke()
    }
  })
  manager = new TunnelManager(
    backend.controller,
    (state) => {
      ui()?.send(IPC.stateEvent, state)
      tray?.update(state)
    },
    logger,
    backend.tail,
    backend.probe,
    () => loadSettings().diagnostics,
    {
      beforeConnect: (id) => sen.beforeConnect(id),
      onStale: (id) => sen.onStale(id),
      subscriptions: () => sen.views(),
      accounts: () => sen.accounts()
    },
    () => loadSettings().recheckSec * 1000
  )
  logger.subscribe((entries) => ui()?.send(IPC.logsEvent, entries))
  logger.info(`SenAWG ${app.getVersion()} запущен`)
  logger.info(describeSystem())
  void reportEngine()
  registerIpc()
}

/**
 * «Подключаться к последнему серверу при запуске». It runs after init, so a tunnel left up from the
 * previous session is already known and nothing is dialled twice. A server that has since been
 * removed is simply not there any more, which is not a failure worth a message.
 */
async function autoConnect(): Promise<void> {
  const { autoConnect: on, lastTunnelId } = loadSettings()
  if (!on || !lastTunnelId) return
  if (manager.snapshot().activeId !== null) return
  if (!listTunnels().some((t) => t.id === lastTunnelId)) return
  try {
    await manager.connect(lastTunnelId)
  } catch (err) {
    logger.error(`Автоподключение не удалось: ${err instanceof Error ? err.message : String(err)}`)
  }
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = loadSettings().theme
  const installed = setupMode ? await readInstalledDir() : null
  // The seamless update starts before the application it replaces has closed, so it cannot take the
  // single-instance lock yet (`primary` waits for that application to go); it does so before it builds the
  // new one. Without --seamless — every application older than this one — it waits here, as it always did.
  const seamless = setupMode && installed ? seamlessOf(process.argv) : null
  if (!seamless && !(await primary)) return

  if (setupMode) {
    // The downloaded exe, unpacked: the window is the installer, and the application starts only once the
    // service it connects through exists. Nothing of the application runs until then — its first act is to
    // ask that service for its state.
    const info: SetupInfo = {
      mode: installed || maintenanceMode ? 'update' : 'install',
      defaultPath: installed ?? defaultInstallDir(),
      buildId: buildId(app.getVersion()),
      auto: Boolean(installed) && isUpdateFromApp(process.argv),
      returning: !installed && !maintenanceMode && listTunnels().length > 0,
      seamless: seamless !== null,
      version: app.getVersion(),
      // Opened again by hand over the same version: nothing to update. One the application started never is.
      alreadyInstalled:
        !maintenanceMode && Boolean(installed) && !isUpdateFromApp(process.argv) && (await readInstalledVersion()) === app.getVersion(),
      maintenance: maintenanceMode
    }
    const reveal = (): void => {
      if (window?.isVisible()) return
      // Maximized here, not at creation: maximizing a hidden window shows it at once.
      if (seamless?.maximized) window?.maximize()
      window?.show()
      window?.focus()
    }
    registerSetupIpc({
      info,
      window: () => window,
      prepareApp: async () => {
        if (seamless && !(await primary)) return app.quit()
        await prepareApp(info.returning === true, seamless !== null)
      },
      showApp: () => {
        showApp()
        // Any update ends the same way on screen; only the seamless one can also connect again by itself.
        if (info.mode === 'update') resumeAfterUpdate(seamless?.reconnect ?? null)
      },
      seamless: seamless
        ? {
            waitPid: waitPidOf(process.argv) ?? 0,
            staged: () => {
              reveal()
              tellApplication(seamless.handoff, 'shown')
            },
            reveal,
            aborted: (why) => {
              tellApplication(seamless.handoff, why.kind, why.kind === 'failed' ? why.message : '')
              app.quit()
            }
          }
        : undefined
    })
    createWindow(info, seamless?.bounds ?? undefined, { hidden: seamless !== null })
    return
  }

  // macOS, opened again by the update it just received (update/mac.ts): where the old window stood.
  const updated = updatedOf(process.argv)
  startApp()
  appShown = true
  // `updated`: the page opens on the main screen from its first frame, not after the note arrives.
  createWindow(undefined, updated?.bounds ?? undefined, updated ? { query: { updated: updated.version } } : {})
  const page = window?.webContents
  const loaded = page ? new Promise<void>((resolve) => page.once('did-finish-load', () => resolve())) : null
  if (updated?.maximized) window?.once('ready-to-show', () => window?.maximize())
  await manager.init()
  sen.start()
  // The swap may have failed and put the old copy back: that one was not updated, and says nothing.
  if (updated && updated.version === app.getVersion()) {
    await loaded
    resumeAfterUpdate(updated.reconnect)
  } else {
    if (updated) logger.warn(`Обновление до ${updated.version} не установилось, открыта прежняя версия`)
    await autoConnect()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// The tunnel never outlives the application, on either system, and neither needs this process to be
// alive to manage it: on Windows the service watches it, on macOS the root monitor started by awg.sh
// does. That is deliberate — a quit can be a crash or a Force Quit, and an unprivileged dying process
// cannot be asked to put the network back the way it was.
app.on('before-quit', () => {
  quitting = true
  tray?.dispose()
  manager?.dispose()
  sen?.dispose()
})
