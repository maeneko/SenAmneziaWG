import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type AppState, type AwgApi, type LogEntry } from '../shared/types'

const api: AwgApi = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  previewLink: (link) => ipcRenderer.invoke(IPC.previewLink, link),
  importLink: (link, name) => ipcRenderer.invoke(IPC.importLink, link, name),
  removeTunnel: (id) => ipcRenderer.invoke(IPC.removeTunnel, id),
  connect: (id) => ipcRenderer.invoke(IPC.connect, id),
  disconnect: (id) => ipcRenderer.invoke(IPC.disconnect, id),
  copyEndpoint: (id) => ipcRenderer.invoke(IPC.copyEndpoint, id),
  cleanup: () => ipcRenderer.invoke(IPC.cleanup),
  setDiagnostics: (enabled) => ipcRenderer.invoke(IPC.setDiagnostics, enabled),
  getAbout: () => ipcRenderer.invoke(IPC.getAbout),
  getUiSettings: () => ipcRenderer.invoke(IPC.getUiSettings),
  setUiSettings: (patch) => ipcRenderer.invoke(IPC.setUiSettings, patch),
  quit: () => ipcRenderer.invoke(IPC.quit),
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
