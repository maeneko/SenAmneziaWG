import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { UI_DEFAULTS, sanitizeUiSettings, type UiSettings } from '../shared/uiSettings'

/** Display preferences (Настройки) live in the same file as the diagnostics switch. */
export interface Settings extends UiSettings {
  /** Packet capture + root snapshot on connect (Logs → «Диагностика подключения»). Off by default. */
  diagnostics: boolean
  /** Which server to bring up at start when autoConnect is on. Written by main, never by the page. */
  lastTunnelId: string | null
  /** Notices closed on the main screen, by id: they do not come back. */
  dismissedNotices: string[]
}

const DEFAULTS: Settings = { diagnostics: false, lastTunnelId: null, dismissedNotices: [], ...UI_DEFAULTS }
const path = (): string => join(app.getPath('userData'), 'settings.json')

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(readFileSync(path(), 'utf8')) as Partial<Settings>
    // A hand-edited or older file must not put unknown values into the UI.
    return {
      ...DEFAULTS,
      diagnostics: raw.diagnostics === true,
      lastTunnelId: typeof raw.lastTunnelId === 'string' ? raw.lastTunnelId : null,
      dismissedNotices: Array.isArray(raw.dismissedNotices) ? raw.dismissedNotices.filter((id): id is string => typeof id === 'string') : [],
      ...sanitizeUiSettings(raw)
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...loadSettings(), ...patch }
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(`${path()}.tmp`, JSON.stringify(next, null, 2))
  renameSync(`${path()}.tmp`, path())
  return next
}

/** «Нет, стереть» on removal. */
export function forgetSettings(): void {
  rmSync(path(), { force: true })
  rmSync(`${path()}.tmp`, { force: true })
}

export function loadUiSettings(): UiSettings {
  const { traffic, units, dnsCustom, autoConnect, autoUpdate, runInBackground, linuxTray, pywal, theme, recheckSec } = loadSettings()
  return { traffic, units, dnsCustom, autoConnect, autoUpdate, runInBackground, linuxTray, pywal, theme, recheckSec }
}
