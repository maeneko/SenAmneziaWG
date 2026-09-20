import { app, BrowserWindow, clipboard, ipcMain, nativeTheme, shell, WebContentsView, type WebContents } from 'electron'
import { join } from 'node:path'
import { IPC, type AboutInfo, type ImportResult, type LogSource, type SetupInfo } from '../shared/types'
import { AWG_VERSION_LABEL, detectAwgVersion } from '../shared/awgVersion'
import { VpnLinkError } from './config/vpnLink'
import { parseVpnLink } from './config/wgConfig'
import { buildId } from './buildId'
import { Logger, formatEntries } from './logger'
import { loadSettings, loadUiSettings, saveSettings } from './settings'
import { resolveDns, sanitizeUiSettings } from '../shared/uiSettings'
import { listTunnels, removeTunnel, saveTunnel } from './store'
import type { Backend } from './tunnel/backend'
import { createBackend } from './tunnel/createBackend'
import { TunnelManager } from './tunnel/manager'
import { measurePing } from './tunnel/ping'
import { registerSetupIpc } from './setup'
import { defaultInstallDir, isSetupMode, readInstalledDir } from './setup/mode'

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

/** Where the application's pushes go: its window, or — after a setup — the view laid over that window. */
const ui = (): WebContents | undefined => (appView ?? window)?.webContents

const setupMode = isSetupMode(process.argv, process.env)

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

function createWindow(setup?: SetupInfo): void {
  window = new BrowserWindow({
    // Phone-sized by default: the single-column layout (design.md Part IV); it can still be widened.
    width: 420,
    height: 780,
    minWidth: 360,
    minHeight: 520,
    show: false,
    backgroundColor: backgroundColor(),
    // macOS keeps its traffic lights over the page (the renderer reserves a strip for them); elsewhere the native frame stays.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The setup bridge is for this window alone: the preload exposes it only when it finds this argument.
      additionalArguments: setup ? [`--awg-setup=${Buffer.from(JSON.stringify(setup)).toString('base64')}`] : []
    }
  })

  window.once('ready-to-show', () => window?.show())
  window.on('closed', () => {
    window = null
    appView = null
  })
  window.on('resize', layoutAppView)

  lockDown(window.webContents)
  loadPage(window.webContents, setup ? 'setup' : 'app')
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
  const view = new WebContentsView({
    webPreferences: { preload: PRELOAD(), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  view.setBackgroundColor(backgroundColor())
  lockDown(view.webContents)
  appView = view
  const loaded = new Promise<void>((resolve) => view.webContents.once('did-finish-load', () => resolve()))
  loadPage(view.webContents, 'app', { from: 'setup' })
  await loaded
  void manager.init()
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
  window.contentView.addChildView(appView)
  layoutAppView()
  appView.webContents.focus()
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

  ipcMain.handle(IPC.connect, (_e, id: string) => manager.connect(id))
  ipcMain.handle(IPC.disconnect, (_e, id: string) => manager.disconnect(id))
  ipcMain.handle(IPC.cleanup, () => manager.cleanup())
  ipcMain.handle(IPC.setDiagnostics, (_e, enabled: boolean) => {
    saveSettings({ diagnostics: enabled === true })
    logger.info(enabled ? 'Диагностика подключения включена (со следующего подключения)' : 'Диагностика подключения выключена')
    ui()?.send(IPC.stateEvent, manager.snapshot())
  })

  // «Об AmnesiaWG» shows this, so a failure is an answer too, not an error dialog.
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
    saveSettings(sanitizeUiSettings(patch))
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

  ipcMain.handle(IPC.quit, () => app.quit())
}

// Two windows would mean two UIs steering one tunnel.
const primary = app.requestSingleInstanceLock()
if (!primary) app.quit()
app.on('second-instance', () => {
  if (window?.isMinimized()) window.restore()
  window?.focus()
})

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
  backend = createBackend({
    resources,
    userData: app.getPath('userData'),
    packaged: app.isPackaged,
    logger,
    diagnostics: () => loadSettings().diagnostics,
    dnsFor: (tunnel) => resolveDns(tunnel.dns, loadSettings())
  })
  manager = new TunnelManager(
    backend.controller,
    (state) => ui()?.send(IPC.stateEvent, state),
    logger,
    backend.tail,
    backend.probe,
    () => loadSettings().diagnostics
  )
  logger.subscribe((entries) => ui()?.send(IPC.logsEvent, entries))
  logger.info(`AmnesiaWG ${app.getVersion()} запущен`)
  void reportEngine()
  registerIpc()
}

app.whenReady().then(async () => {
  if (!primary) return

  if (setupMode) {
    // The downloaded exe, unpacked: the window is the installer, and the application starts only once the
    // service it connects through exists. Nothing of the application runs until then — its first act is to
    // ask that service for its state.
    const installed = await readInstalledDir()
    const info: SetupInfo = {
      mode: installed ? 'update' : 'install',
      defaultPath: installed ?? defaultInstallDir(),
      buildId: buildId(app.getVersion())
    }
    registerSetupIpc({ info, window: () => window, prepareApp, showApp })
    createWindow(info)
    return
  }

  startApp()
  createWindow()
  await manager.init()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// macOS: a running tunnel deliberately outlives the app — stopping it needs an admin prompt, and the
// next launch reattaches through the root-owned state file. Windows: the service watches this process
// and stops the tunnel once it is gone, so there is nothing to reattach to.
app.on('before-quit', () => manager?.dispose())
