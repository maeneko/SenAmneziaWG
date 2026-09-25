/*
 * Browser-only stand-in for the preload bridge (src/preload), loaded by main.tsx in `vite dev` when there is
 * no `window.awg` — so none of this reaches the packaged app. It plays one scenario, picked by the page's
 * query, for the harness in src/renderer/demo/:
 *
 *   ?demo=mac-update   the update on macOS (src/main/update/mac.ts): check, download, «Перезапустить и
 *                      обновить», then the harness closes this page and opens it again with `updated=`.
 *
 *   ?sen=ok|pending|revoked   a server that a sen:// master key keeps up to date, in that state (and a
 *                      `sen://` link previews as a master key); look at it at /index.html?sen=pending.
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
  diagnostics: false,
  subscriptions: []
}
// A master key's server: `?sen=pending` (new settings wait for the next connect) or `revoked` (the server
// no longer knows this device); `ok` is the plain case.
const senMode = query.get('sen')
if (senMode) {
  const senTunnel = { ...tunnel, id: 'sen', name: 'Семья', endpoint: '203.0.113.7:47619', source: { kind: 'sen' as const, subId: 'demo-sub', serverId: 0 } }
  const senTunnel2 = { ...senTunnel, id: 'sen2', name: 'Семья · Германия', endpoint: '198.51.100.9:443', source: { kind: 'sen' as const, subId: 'demo-sub', serverId: 1 } }
  const on = senMode !== 'revoked'
  state = {
    ...state,
    tunnels: [senTunnel, tunnel, senTunnel2],
    states: {
      sen: on ? { id: 'sen', status: 'up', since, stats } : { id: 'sen', status: 'down' },
      nl: { id: 'nl', status: 'down' },
      sen2: { id: 'sen2', status: 'down' }
    },
    activeId: on ? 'sen' : null,
    busy: false,
    subscriptions: [{ id: 'demo-sub', name: 'Семья', status: senMode === 'revoked' ? 'revoked' : 'ok', pendingRev: senMode === 'pending', plain: true, checkedAt: Date.now() }]
  }
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
  previewLink: async (link) =>
    link.trim().startsWith('sen://')
      ? { ok: true, master: { name: 'Семья', address: '203.0.113.7:40123', tls: link.includes('tls') } }
      : { ok: false, error: 'В демо ключи не добавляются' },
  // A sen:// link adds the demo master key with its two servers (once); a vpn:// key is refused.
  importLink: async (link) => {
    if (!link.trim().startsWith('sen://')) return { ok: false, error: 'В демо добавляются только ключи sen://' }
    if (state.subscriptions.length) return { ok: false, error: 'Этот мастер-ключ уже добавлен' }
    await wait(900)
    const base = { ...tunnel, name: 'Семья', endpoint: '203.0.113.7:47619' }
    const first = { ...base, id: 'sen', source: { kind: 'sen' as const, subId: 'demo-sub', serverId: 0 } }
    const second = { ...base, id: 'sen2', name: 'Семья · Германия', endpoint: '198.51.100.9:443', source: { kind: 'sen' as const, subId: 'demo-sub', serverId: 1 } }
    setState({
      ...state,
      tunnels: [...state.tunnels, first, second],
      states: { ...state.states, sen: { id: 'sen', status: 'down' }, sen2: { id: 'sen2', status: 'down' } },
      subscriptions: [{ id: 'demo-sub', name: 'Семья', status: 'ok', pendingRev: false, plain: !link.includes('tls'), checkedAt: Date.now() }]
    })
    return { ok: true, tunnel: first, bindings: { used: 3, limit: 5 } }
  },
  removeTunnel: async () => undefined,
  refreshSubscription: async () => {
    await wait(700)
    setState({ ...state, subscriptions: state.subscriptions.map((x) => ({ ...x, checkedAt: Date.now() })) })
  },
  peekKey: async () => {
    await wait(500)
    return { used: 2, limit: 5 }
  },
  getKeyDevices: async () => {
    await wait(400)
    const sec = Math.floor(Date.now() / 1000)
    return {
      limit: 5,
      devices: [
        { id: 1, name: 'MacBook Ивана', platform: 'macos', version: '0.6.5', createdAt: sec - 86400 * 9, lastSeen: sec - 240, current: true },
        { id: 2, name: 'Windows-ПК', platform: 'windows', version: '0.6.2', createdAt: sec - 86400 * 30, lastSeen: sec - 3 * 3600, current: false },
        { id: 3, name: 'Pixel 8', platform: 'android', version: '', createdAt: sec - 86400, lastSeen: null, current: false }
      ]
    }
  },
  // Unbinding is only offered while the key's servers are not connected: try it at ?sen=revoked.
  removeSubscription: async () => {
    await wait(800)
    setState({ ...state, tunnels: state.tunnels.filter((t) => !t.source), subscriptions: [], activeId: null })
  },
  // Connecting and disconnecting work, so that «Отвязать» (offered only with the key's servers down) can be tried.
  connect: async (id) => {
    setState({ ...state, busy: true, activeId: id, states: { ...state.states, [id]: { id, status: 'connecting' } } })
    await wait(900)
    setState({ ...state, busy: false, states: { ...state.states, [id]: { id, status: 'up', since: Date.now(), stats } } })
  },
  disconnect: async (id) => {
    setState({ ...state, busy: true })
    await wait(600)
    setState({ ...state, busy: false, activeId: null, states: { ...state.states, [id]: { id, status: 'down' } } })
  },
  reconnect: async () => {
    const id = state.activeId
    if (!id) return
    setState({ ...state, busy: true, states: { ...state.states, [id]: { id, status: 'connecting' } } })
    await wait(900)
    setState({
      ...state,
      busy: false,
      states: { ...state.states, [id]: { id, status: 'up', since: Date.now(), stats } },
      // The new settings are in: the note about them goes.
      subscriptions: state.subscriptions.map((x) => ({ ...x, pendingRev: false }))
    })
  },
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
