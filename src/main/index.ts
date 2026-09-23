import { app, BrowserWindow, clipboard, ipcMain, nativeTheme, shell, WebContentsView, type WebContents } from 'electron'
import { join } from 'node:path'
import { IPC, type AboutInfo, type ImportResult, type LogSource, type SetupInfo } from '../shared/types'
import { AWG_VERSION_LABEL, detectAwgVersion } from '../shared/awgVersion'
import { VpnLinkError } from './config/vpnLink'
import { parseVpnLink } from './config/wgConfig'
import { buildId } from './buildId'
import { Logger, RepeatFilter, formatEntries, parseDaemonLine } from './logger'
import { loadSettings, loadUiSettings, saveSettings } from './settings'
import { resolveDns, sanitizeUiSettings } from '../shared/uiSettings'
import { listTunnels, removeTunnel, saveTunnel } from './store'
import type { Backend } from './tunnel/backend'
import { createBackend } from './tunnel/createBackend'
import { TunnelManager } from './tunnel/manager'
import { measurePing } from './tunnel/ping'
import { readAppOptions, writeAutoStart } from './appOptions'
import { createTray, type AppTray } from './tray'
import { createUninstaller } from './uninstall'
import { startUpdater } from './update'
import { registerSetupIpc } from './setup'
import { defaultInstallDir, isSetupMode, isUpdateFromApp, readInstalledDir, waitForExit, waitPidOf } from './setup/mode'

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

const setupMode = isSetupMode(process.argv, process.env)

/** Windows: closing the window hides it behind the notification-area icon (Настройки → «Работать в фоне»). */
const backgroundOn = (): boolean => process.platform === 'win32' && loadSettings().runInBackground

/** The square Windows icon (build/icon-win.png), shipped next to the helper so the tray can use it. */
const winIcon = (): string =>
  app.isPackaged ? join(process.resourcesPath, 'win', 'icon-win.png') : join(__dirname, '../../build/icon-win.png')

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
function createWindow(setup?: SetupInfo, bounds?: Electron.Rectangle): void {
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
    ...(process.platform === 'win32' ? { icon: winIcon() } : {}),
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
  win.once('ready-to-show', () => win.show())
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
  loadPage(win.webContents, setup ? 'setup' : 'app')
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
async function prepareApp(): Promise<void> {
  if (!window) return
  startApp()
  await buildAppView(true)
}

/** `init`: a fresh application, whose manager has yet to learn the state of the tunnel. */
async function buildAppView(init: boolean): Promise<void> {
  if (!window) return
  const view = new WebContentsView({
    webPreferences: { preload: PRELOAD(), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  view.setBackgroundColor(backgroundColor())
  lockDown(view.webContents)
  appView = view
  const loaded = new Promise<void>((resolve) => view.webContents.once('did-finish-load', () => resolve()))
  loadPage(view.webContents, 'app', { from: 'setup' })
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

let updateScreenIpc = false

/**
 * `npm run dev` with AWG_UPDATE_SIMULATE, «Перезапустить и обновить»: the update screen as the downloaded
 * installer will show it — in place of the window, already at work, then the application again. The real
 * one is a new process with new files; here nothing is replaced, so this process plays both parts.
 */
function playUpdateScreen(): void {
  const old = window
  const info: SetupInfo = { mode: 'update', defaultPath: defaultInstallDir(), buildId: buildId(app.getVersion()), auto: true }
  if (!updateScreenIpc) {
    registerSetupIpc({ info, window: () => window, prepareApp: () => buildAppView(false), showApp })
    updateScreenIpc = true
  }
  appShown = false
  createWindow(info, old?.getBounds())
  // destroy, not close: a close would be taken for the user's and only hide the old window.
  old?.destroy()
}

function parse(link: string, name?: string): ImportResult {
  try {
    return { ok: true, tunnel: parseVpnLink(link, name).tunnel }
  } catch (err) {
    if (err instanceof VpnLinkError) return { ok: false, error: err.message }
    return { ok: false, error: 'Не удалось разобрать ссылку' }
  }
}

function registerIpc(): void {
  const updater = startUpdater({
    send: (channel, state) => ui()?.send(channel, state),
    log: (level, message) => logger[level](message),
    automatic: () => loadSettings().autoUpdate,
    playUpdateScreen
  })

  ipcMain.handle(IPC.getState, () => manager.snapshot())
  ipcMain.handle(IPC.previewLink, (_e, link: string) => parse(link))

  ipcMain.handle(IPC.importLink, (_e, link: string, name?: string): ImportResult => {
    try {
      const parsed = parseVpnLink(link, name)
      saveTunnel(parsed)
      logger.info(
        `Добавлен сервер «${parsed.tunnel.name}» (${parsed.tunnel.endpoint}, ${AWG_VERSION_LABEL[detectAwgVersion(parsed.tunnel.awg)]})`
      )
      ui()?.send(IPC.stateEvent, manager.snapshot())
      return { ok: true, tunnel: parsed.tunnel }
    } catch (err) {
      if (err instanceof VpnLinkError) return { ok: false, error: err.message }
      return { ok: false, error: err instanceof Error ? err.message : 'Не удалось сохранить туннель' }
    }
  })

  ipcMain.handle(IPC.removeTunnel, (_e, id: string) => {
    if (manager.isActive(id)) throw new Error('Сначала отключите туннель')
    const name = listTunnels().find((t) => t.id === id)?.name
    removeTunnel(id)
    logger.info(`Удалён сервер «${name ?? id}»`)
    manager.forget(id)
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

  ipcMain.handle(IPC.getUiSettings, () => loadUiSettings())
  ipcMain.handle(IPC.setUiSettings, (_e, patch: unknown) => {
    const clean = sanitizeUiSettings(patch)
    const wasAutomatic = loadSettings().autoUpdate
    saveSettings(clean)
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

  ipcMain.handle(IPC.getUpdate, () => updater.get())
  ipcMain.handle(IPC.checkForUpdate, () => updater.check())
  ipcMain.handle(IPC.downloadUpdate, () => updater.download())
  ipcMain.handle(IPC.installUpdate, () => updater.install())
}

// Two windows would mean two UIs steering one tunnel. The update screen started by «Перезапустить и
// обновить» comes up while that application is still closing, and must not take it for a second window.
const primary = waitForExit(setupMode ? waitPidOf(process.argv) : null).then(() => {
  const got = app.requestSingleInstanceLock()
  if (!got) app.quit()
  return got
})
app.on('second-instance', () => showWindow())

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
  if (process.platform === 'win32') {
    tray = createTray({
      icon: winIcon(),
      show: showWindow,
      disconnect: (id) =>
        void manager.disconnect(id).catch((err) => logger.error(err instanceof Error ? err.message : String(err))),
      quit: () => app.quit()
    })
    tray.setEnabled(backgroundOn())
  }
  manager = new TunnelManager(
    backend.controller,
    (state) => {
      ui()?.send(IPC.stateEvent, state)
      tray?.update(state)
    },
    logger,
    backend.tail,
    backend.probe,
    () => loadSettings().diagnostics
  )
  logger.subscribe((entries) => ui()?.send(IPC.logsEvent, entries))
  logger.info(`SenAWG ${app.getVersion()} запущен`)
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
  if (!(await primary)) return

  if (setupMode) {
    // The downloaded exe, unpacked: the window is the installer, and the application starts only once the
    // service it connects through exists. Nothing of the application runs until then — its first act is to
    // ask that service for its state.
    const installed = await readInstalledDir()
    const info: SetupInfo = {
      mode: installed ? 'update' : 'install',
      defaultPath: installed ?? defaultInstallDir(),
      buildId: buildId(app.getVersion()),
      auto: Boolean(installed) && isUpdateFromApp(process.argv)
    }
    registerSetupIpc({ info, window: () => window, prepareApp, showApp })
    createWindow(info)
    return
  }

  startApp()
  appShown = true
  createWindow()
  await manager.init()
  await autoConnect()

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
})
