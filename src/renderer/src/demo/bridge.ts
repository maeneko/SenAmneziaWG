/*
 * Browser-only stand-in for the preload bridge (src/preload), loaded by main.tsx in `vite dev` when there is
 * no `window.awg` — so none of this reaches the packaged app. It plays one scenario, picked by the page's
 * query, for the harness in src/renderer/demo/:
 *
 *   ?demo=mac-update   the update on macOS (src/main/update/mac.ts): check, download, «Перезапустить и
 *                      обновить», then the harness closes this page and opens it again with `updated=`.
 *
 * Query: `speed` (0.5, 1, 2), `start=ready` (skip to «готова к установке»), `updated=<version>` (this is the
 * new copy, opened by the update), `failed=1` (the swap failed: the old copy opened, it says nothing).
 */
import type { AppState, AwgApi, LogEntry, UpdateState } from '@shared/types'
import { UI_DEFAULTS, type UiSettings } from '@shared/uiSettings'

const query = new URLSearchParams(location.search)
const speed = Number(query.get('speed')) || 1
const updated = query.get('updated')
const failed = query.get('failed') === '1'
const current = updated && !failed ? updated : null
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms / speed))

// vite.demo.config.ts leaves __APP_VERSION__ a global for this file to set: the version being played.
declare const __BUILD_VERSION__: string
/** The page reads the version as a global (env.d.ts); here it is written. */
const globals = globalThis as unknown as { __APP_VERSION__: string }
const BUILD = typeof __BUILD_VERSION__ === 'string' ? __BUILD_VERSION__ : '0.0.0'

/** One patch above this build: what the site offers. */
const NEXT = BUILD.replace(/(\d+)(\D*)$/, (_, n: string, rest: string) => `${Number(n) + 1}${rest}`)

/** Tell the harness (the parent page) what is happening; nothing listens when the page is opened alone. */
const tell = (step: string, data: Record<string, unknown> = {}): void => window.parent.postMessage({ type: 'senawg-demo', step, ...data }, '*')

globals.__APP_VERSION__ = current ?? BUILD

// The macOS window: the strip for the traffic lights, whatever the viewer's own system is.
document.documentElement.dataset.platform = 'mac'
// Opened on «Настройки → Приложение», where the update card is. The new copy opens where the old one was.
try {
  if (!updated) {
    localStorage.setItem('awg:view', 'settings')
    localStorage.setItem('awg:settingsTab', 'app')
  }
} catch {
  /* the card is one click away */
}

const tunnel = {
  id: 'nl',
  name: 'Нидерланды',
  endpoint: '185.12.34.56:51820',
  address: '10.8.0.2/32',
  dns: ['1.1.1.1'],
  allowedIps: ['0.0.0.0/0'],
  peerPublicKey: 'demo',
  awg: { jc: 4, jmin: 40, jmax: 70, s1: 0, s2: 0, h1: '1', h2: '2', h3: '3', h4: '4', extra: {} }
}
const since = Date.now() - 12 * 60_000
const stats = { rxBytes: 184_000_000, txBytes: 21_000_000, lastHandshakeSec: 4 }

// The new copy starts with the tunnel down — it went with the old process — and connects again.
const reconnecting = updated !== null && !failed
let state: AppState = {
  tunnels: [tunnel],
  states: { nl: reconnecting ? { id: 'nl', status: 'connecting' } : { id: 'nl', status: 'up', since, stats } },
  activeId: 'nl',
  busy: reconnecting,
  switching: false,
  needsCleanup: false,
  degraded: null,
  diagnostics: false
}
const stateListeners = new Set<(s: AppState) => void>()
const setState = (next: AppState): void => {
  state = next
  stateListeners.forEach((cb) => cb(state))
}
if (reconnecting) {
  void wait(2400).then(() => setState({ ...state, busy: false, states: { nl: { id: 'nl', status: 'up', since: Date.now(), stats: { rxBytes: 0, txBytes: 0, lastHandshakeSec: 1 } } } }))
}

const NOTES = ['Обновления на macOS', 'Окно после обновления открывается на прежнем месте']
const TOTAL = 118_000_000
let update: UpdateState =
  query.get('start') === 'ready' && !updated
    ? { kind: 'ready', version: NEXT, notes: NOTES }
    : { kind: 'idle', checkedAt: updated ? null : Date.now() - 3 * 3_600_000 }
const updateListeners = new Set<(s: UpdateState) => void>()
const setUpdate = (next: UpdateState): void => {
  update = next
  updateListeners.forEach((cb) => cb(update))
  tell(update.kind, 'version' in update ? { version: update.version } : {})
}

let ui: UiSettings = { ...UI_DEFAULTS }
const noop = (): (() => void) => () => undefined
const logs: LogEntry[] = []

const api: AwgApi = {
  getState: async () => state,
  onState: (cb) => {
    stateListeners.add(cb)
    return () => stateListeners.delete(cb)
  },
  previewLink: async () => ({ ok: false, error: 'В демо ключи не добавляются' }),
  importLink: async () => ({ ok: false, error: 'В демо ключи не добавляются' }),
  removeTunnel: async () => undefined,
  connect: async () => undefined,
  disconnect: async () => undefined,
  reconnect: async () => undefined,
  copyEndpoint: async () => undefined,
  ping: async () => 38,
  getAppOptions: async () => ({ supported: true, canUninstall: false, autoStart: false, canRunInBackground: false }),
  setAutoStart: async (on) => on,
  uninstall: async () => 'cancelled',
  onUninstallProgress: noop,
  onUninstallFailed: noop,
  finishUninstall: async () => undefined,
  cleanup: async () => undefined,
  setDiagnostics: async () => undefined,
  getAbout: async () => ({ app: `release-${globals.__APP_VERSION__}-mac`, engine: 'amneziawg-go (демо)' }),
  getUiSettings: async () => ui,
  setUiSettings: async (patch) => (ui = { ...ui, ...patch }),
  getLogs: async () => logs,
  clearLogs: async () => undefined,
  copyLogs: async () => undefined,
  onLogs: noop,
  update: {
    getUpdate: async () => update,
    onUpdate: (cb) => {
      updateListeners.add(cb)
      return () => updateListeners.delete(cb)
    },
    async checkForUpdate() {
      setUpdate({ kind: 'checking' })
      await wait(1400)
      setUpdate({ kind: 'available', version: NEXT, notes: NOTES, total: TOTAL })
    },
    async downloadUpdate() {
      if (update.kind !== 'available') return
      for (let received = 0; received < TOTAL; received += TOTAL / 24) {
        setUpdate({ kind: 'downloading', version: NEXT, notes: NOTES, received, total: TOTAL })
        await wait(110)
      }
      setUpdate({ kind: 'ready', version: NEXT, notes: NOTES })
    },
    async installUpdate() {
      // update/mac.ts: the image is mounted, checked and copied beside the running copy, then this quits.
      setUpdate({ kind: 'installing', version: NEXT })
      await wait(2600)
      tell('quit', { version: NEXT })
    },
    // The new copy: main/index.ts sends this once its page has loaded (resumeAfterUpdate).
    onUpdated: (cb) => {
      if (!updated || failed) return () => undefined
      const t = setTimeout(() => cb(updated), 50)
      return () => clearTimeout(t)
    }
  }
}

window.awg = api
if (update.kind === 'ready') tell('ready', { version: update.version })
tell('loaded', { version: globals.__APP_VERSION__, updated: current !== null })
