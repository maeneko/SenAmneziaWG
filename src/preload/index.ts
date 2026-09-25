import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type AppState,
  type AwgApi,
  type AwgSetupApi,
  type LogEntry,
  type SetupFailure,
  type SetupInfo,
  type SetupPasswordRequest,
  type SetupProgress,
  type UpdateState
} from '../shared/types'

const api: AwgApi = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  previewLink: (link) => ipcRenderer.invoke(IPC.previewLink, link),
  importLink: (link, name) => ipcRenderer.invoke(IPC.importLink, link, name),
  removeTunnel: (id) => ipcRenderer.invoke(IPC.removeTunnel, id),
  refreshSubscription: (id) => ipcRenderer.invoke(IPC.refreshSubscription, id),
  peekKey: (link) => ipcRenderer.invoke(IPC.peekKey, link),
  getKeyDevices: (id) => ipcRenderer.invoke(IPC.getKeyDevices, id),
  removeSubscription: (id) => ipcRenderer.invoke(IPC.removeSubscription, id),
  connect: (id) => ipcRenderer.invoke(IPC.connect, id),
  disconnect: (id) => ipcRenderer.invoke(IPC.disconnect, id),
  copyEndpoint: (id) => ipcRenderer.invoke(IPC.copyEndpoint, id),
  ping: (id) => ipcRenderer.invoke(IPC.ping, id),
  getAppOptions: () => ipcRenderer.invoke(IPC.getAppOptions),
  setAutoStart: (enabled) => ipcRenderer.invoke(IPC.setAutoStart, enabled),
  uninstall: (keepData) => ipcRenderer.invoke(IPC.uninstall, keepData),
  onUninstallProgress: (cb) => {
    const listener = (_: unknown, event: SetupProgress): void => cb(event)
    ipcRenderer.on(IPC.uninstallProgress, listener)
    return () => ipcRenderer.removeListener(IPC.uninstallProgress, listener)
  },
  onUninstallFailed: (cb) => {
    const listener = (_: unknown, event: SetupFailure): void => cb(event)
    ipcRenderer.on(IPC.uninstallFailed, listener)
    return () => ipcRenderer.removeListener(IPC.uninstallFailed, listener)
  },
  finishUninstall: () => ipcRenderer.invoke(IPC.finishUninstall),
  update: {
    getUpdate: () => ipcRenderer.invoke(IPC.getUpdate),
    checkForUpdate: () => ipcRenderer.invoke(IPC.checkForUpdate),
    downloadUpdate: () => ipcRenderer.invoke(IPC.downloadUpdate),
    installUpdate: () => ipcRenderer.invoke(IPC.installUpdate),
    onUpdate: (cb) => {
      const listener = (_: unknown, state: UpdateState): void => cb(state)
      ipcRenderer.on(IPC.updateState, listener)
      return () => ipcRenderer.removeListener(IPC.updateState, listener)
    },
    onUpdated: (cb) => {
      const listener = (_: unknown, version: string): void => cb(version)
      ipcRenderer.on(IPC.updated, listener)
      return () => ipcRenderer.removeListener(IPC.updated, listener)
    }
  },
  cleanup: () => ipcRenderer.invoke(IPC.cleanup),
  reconnect: () => ipcRenderer.invoke(IPC.reconnect),
  setDiagnostics: (enabled) => ipcRenderer.invoke(IPC.setDiagnostics, enabled),
  getAbout: () => ipcRenderer.invoke(IPC.getAbout),
  getUiSettings: () => ipcRenderer.invoke(IPC.getUiSettings),
  setUiSettings: (patch) => ipcRenderer.invoke(IPC.setUiSettings, patch),
  getLogs: () => ipcRenderer.invoke(IPC.getLogs),
  clearLogs: () => ipcRenderer.invoke(IPC.clearLogs),
  copyLogs: (source) => ipcRenderer.invoke(IPC.copyLogs, source),
  onLogs: (cb) => {
    const listener = (_: unknown, entries: LogEntry[]): void => cb(entries)
    ipcRenderer.on(IPC.logsEvent, listener)
    return () => ipcRenderer.removeListener(IPC.logsEvent, listener)
  },
  onState: (cb) => {
    const listener = (_: unknown, state: AppState): void => cb(state)
    ipcRenderer.on(IPC.stateEvent, listener)
    return () => ipcRenderer.removeListener(IPC.stateEvent, listener)
  }
}

contextBridge.exposeInMainWorld('awg', api)

/**
 * Only the setup window gets the setup bridge: main hands it over as an argument of that window alone
 * (see createWindow), so the application page never sees `awgSetup`.
 */
const SETUP_ARG = '--awg-setup='
const setupArg = process.argv.find((a) => a.startsWith(SETUP_ARG))
if (setupArg) {
  const info = JSON.parse(Buffer.from(setupArg.slice(SETUP_ARG.length), 'base64').toString('utf8')) as SetupInfo
  const setup: AwgSetupApi = {
    ...info,
    pickFolder: () => ipcRenderer.invoke(IPC.setupPickFolder),
    install: (path, options) => ipcRenderer.invoke(IPC.setupInstall, path, options),
    onProgress: (cb) => {
      ipcRenderer.on(IPC.setupProgress, (_: unknown, event: SetupProgress) => cb(event))
    },
    onFailed: (cb) => {
      ipcRenderer.on(IPC.setupFailed, (_: unknown, event: SetupFailure) => cb(event))
    },
    onPassword: (cb) => {
      ipcRenderer.on(IPC.setupPassword, (_: unknown, request: SetupPasswordRequest) => cb(request))
    },
    answerPassword: (password) => ipcRenderer.send(IPC.setupPasswordAnswer, password),
    entered: () => ipcRenderer.send(IPC.setupEntered)
  }
  contextBridge.exposeInMainWorld('awgSetup', setup)
}
