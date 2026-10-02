/*
 * Browser-only stand-in for the preload bridge (src/preload) for the UI lab, src/renderer/demo/lab.html:
 * main.tsx loads it instead of bridge.ts for ?demo=lab in `vite dev`, so none of this reaches the packaged app.
 * Whatever the main process would decide, the lab's panel decides: the page reads its LabConfig from the
 * parent at the moment of each call, and the panel drives the state through window.awgLab (LabControl).
 * Opened alone (/index.html?demo=lab) it runs on the defaults.
 *
 * Query: `preset` (LabPreset: the servers and keys to start with), `platform` (mac, win, linux — also read
 * by lib/platform.ts).
 */
import type { AppNotice, AppState, AwgApi, KeyDevice, LogEntry, LogLevel, LogSource, SetupFailure, SetupProgress, Tunnel, TunnelState, TunnelStats, UpdateState } from '@shared/types'
import { BETA_NOTICE } from '@shared/notices'
import { UI_DEFAULTS, type UiSettings } from '@shared/uiSettings'
import { labDefaults, type LabConfig, type LabControl, type LabMessage, type LabNotice, type LabPlatform, type LabPreset, type LabTheme, type LabTraffic, type LabUpdate } from './labConfig'

const query = new URLSearchParams(location.search)
const platform: LabPlatform = (['mac', 'win', 'linux'] as const).find((p) => p === query.get('platform')) ?? 'mac'
const preset: LabPreset = (['empty', 'one', 'many', 'sen', 'sen-two', 'account'] as const).find((p) => p === query.get('preset')) ?? 'one'

const fallback = labDefaults(platform)
/** The panel's settings as they are now; the defaults when the page is opened on its own. */
const cfg = (): LabConfig => {
  try {
    return (window.parent as unknown as { awgLabConfig?: LabConfig }).awgLabConfig ?? fallback
  } catch {
    return fallback
  }
}
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms / (cfg().speed || 1)))

// vite.demo.config.ts leaves __APP_VERSION__ a global for the demo bridges to set.
declare const __BUILD_VERSION__: string
const globals = globalThis as unknown as { __APP_VERSION__: string }
const BUILD = typeof __BUILD_VERSION__ === 'string' ? __BUILD_VERSION__ : '0.0.0'
const NEXT = BUILD.replace(/(\d+)(\D*)$/, (_, n: string, rest: string) => `${Number(n) + 1}${rest}`)
globals.__APP_VERSION__ = BUILD

// ——— Servers and keys ———

const AWG = { jc: 4, jmin: 40, jmax: 70, s1: 0, s2: 0, h1: '1', h2: '2', h3: '3', h4: '4', extra: {} }
let serial = 0
function server(name: string, endpoint: string, sub?: { subId: string; serverId: number }): Tunnel {
  serial += 1
  return {
    id: `t${serial}`,
    name,
    endpoint,
    address: `10.8.0.${serial + 1}/32`,
    dns: ['1.1.1.1', '1.0.0.1'],
    allowedIps: ['0.0.0.0/0'],
    peerPublicKey: 'lab',
    awg: AWG,
    ...(sub ? { source: { kind: 'sen' as const, ...sub } } : {})
  }
}
/** The MA7 login the lab's keys are issued to, and the one a pasted `sen://…#ma7_…` link brings. */
const LAB_LOGIN = 'ma7_3f9a1c'
const masterKey = (id: string, name: string, status: 'ok' | 'offline' | 'revoked' = 'ok', login?: string) => ({
  id,
  name,
  status,
  pendingRev: false,
  plain: false,
  checkedAt: Date.now() - 5 * 60_000,
  ...(login ? { login } : {})
})

function initial(): AppState {
  const nl = (): Tunnel => server('Нидерланды', '185.12.34.56:51820')
  let tunnels: Tunnel[] = []
  let subscriptions: AppState['subscriptions'] = []
  let accounts: string[] = []
  switch (preset) {
    case 'empty':
      break
    case 'account':
      accounts = [LAB_LOGIN]
      break
    case 'one':
      tunnels = [nl()]
      break
    case 'many':
      tunnels = [
        nl(),
        server('Германия · Франкфурт', '203.0.113.20:443'),
        server('Финляндия', '198.51.100.3:51820'),
        server('Очень длинное название сервера, которое не помещается ни в одну строку', '192.0.2.44:8443'),
        server('США · Нью-Йорк', '[2001:db8::1]:51820'),
        server('Япония', '203.0.113.99:51820')
      ]
      break
    case 'sen':
      tunnels = [server('Семья', '203.0.113.7:47619', { subId: 'family', serverId: 0 }), server('Семья · Германия', '198.51.100.9:443', { subId: 'family', serverId: 1 }), nl()]
      subscriptions = [masterKey('family', 'Семья', 'ok', LAB_LOGIN)]
      break
    case 'sen-two':
      tunnels = [
        server('Семья', '203.0.113.7:47619', { subId: 'family', serverId: 0 }),
        server('Семья · Германия', '198.51.100.9:443', { subId: 'family', serverId: 1 }),
        server('Работа', '192.0.2.10:51820', { subId: 'work', serverId: 0 }),
        nl()
      ]
      subscriptions = [masterKey('family', 'Семья', 'ok', LAB_LOGIN), masterKey('work', 'Работа', 'offline')]
      break
  }
  return {
    tunnels,
    states: Object.fromEntries(tunnels.map((t) => [t.id, { id: t.id, status: 'down' as const }])),
    activeId: null,
    busy: false,
    switching: false,
    needsCleanup: false,
    degraded: null,
    diagnostics: false,
    subscriptions,
    accounts: [...new Set([...accounts, ...subscriptions.flatMap((s) => (s.login ? [s.login] : []))])]
  }
}

// ——— State and who listens to it ———

let state = initial()
/** An MA7 account: «Профиль» is there, and the beta notice with it. */
const hasProfile = (): boolean => state.accounts.length > 0
const noticeListeners = new Set<(n: AppNotice[]) => void>()
let update: UpdateState = { kind: 'idle', checkedAt: Date.now() - 3 * 3_600_000 }
const stateListeners = new Set<(s: AppState) => void>()
const updateListeners = new Set<(s: UpdateState) => void>()
const updatedListeners = new Set<(version: string) => void>()
const labListeners = new Set<(s: AppState, u: UpdateState) => void>()
const tellLab = (): void => labListeners.forEach((cb) => cb(state, update))

const setState = (next: Partial<AppState>): void => {
  const hadProfile = hasProfile()
  state = { ...state, ...next }
  stateListeners.forEach((cb) => cb(state))
  tellLab()
  if (hasProfile() !== hadProfile) noticeListeners.forEach((cb) => cb(shownNotices()))
}
const setTunnel = (id: string, next: TunnelState, states = state.states): AppState['states'] => ({ ...states, [id]: next })
/** Every other server down: one runs at a time. */
const othersDown = (id: string | null): AppState['states'] =>
  Object.fromEntries(state.tunnels.map((t) => [t.id, t.id === id ? state.states[t.id] : { id: t.id, status: 'down' as const }]))

const setUpdateState = (next: UpdateState): void => {
  update = next
  updateListeners.forEach((cb) => cb(update))
  tellLab()
}

const TRAFFIC: Record<LabTraffic, { stats: TunnelStats; ageMs: number }> = {
  zero: { stats: { rxBytes: 0, txBytes: 0, lastHandshakeSec: 1 }, ageMs: 2_000 },
  some: { stats: { rxBytes: 184_000_000, txBytes: 21_000_000, lastHandshakeSec: 4 }, ageMs: 12 * 60_000 },
  lots: { stats: { rxBytes: 48_300_000_000, txBytes: 3_200_000_000, lastHandshakeSec: 12 }, ageMs: 3 * 86_400_000 + 5 * 3_600_000 },
  stale: { stats: { rxBytes: 184_000_000, txBytes: 21_000_000, lastHandshakeSec: 200 }, ageMs: 40 * 60_000 }
}
let traffic: LabTraffic = 'some'
const upState = (id: string): TunnelState => ({ id, status: 'up', since: Date.now() - TRAFFIC[traffic].ageMs, stats: TRAFFIC[traffic].stats })

// ——— A master key that forgot this device ———

/** Master keys whose server no longer knows this device: the panel's «Отвязать неожиданно». */
const unbound = new Set<string>()
const subOf = (tunnelId: string | null): string | undefined => state.tunnels.find((t) => t.id === tunnelId)?.source?.subId
/** Up on a key the server has forgotten: the peer is gone, so nothing comes back past the handshake attempts. */
const deadState = (id: string): TunnelState => ({ id, status: 'up', since: Date.now(), stats: { rxBytes: 0, txBytes: 14_800, lastHandshakeSec: 0 } })
const upOrDead = (id: string): TunnelState => (unbound.has(subOf(id) ?? '') ? deadState(id) : upState(id))

/** The 410, as sen/manager.ts takes it: the key and its servers leave, the account stays, a notice says why. */
function revoke(subId: string): void {
  const sub = state.subscriptions.find((s) => s.id === subId)
  if (!sub) return
  unbound.delete(subId)
  const gone = new Set(state.tunnels.filter((t) => t.source?.subId === subId).map((t) => t.id))
  logLine('warn', 'app', `Мастер-ключ «${sub.name}» отозван: сервер удалил это устройство. Его серверы убраны с компьютера`)
  setState({
    tunnels: state.tunnels.filter((t) => !gone.has(t.id)),
    states: Object.fromEntries(Object.entries(state.states).filter(([k]) => !gone.has(k))),
    activeId: state.activeId && gone.has(state.activeId) ? null : state.activeId,
    busy: false,
    subscriptions: state.subscriptions.filter((s) => s.id !== subId)
  })
  const account = state.accounts.length > 0
  setNotices([
    ...notices,
    {
      id: `sen-revoked-${subId}`,
      tone: 'error',
      priority: 'high',
      title: `Мастер-ключ «${sub.name}» отозван`,
      text: account
        ? 'Его серверы убраны с компьютера. Если подписка оплачена, получите новый ключ в Telegram-боте MA7.'
        : 'Его серверы убраны с компьютера. Чтобы снова подключиться, нужен новый ключ.',
      ...(account ? { action: { label: 'Профиль', view: 'profile' as const } } : {}),
      dismissible: true,
      at: Date.now()
    }
  ])
}

/**
 * As the main process lives it: the server drops the peer, the handshakes stop, the watchdog asks the server
 * for the settings (sen/manager.ts onStale) and hears 410. Nothing of the key running: the next poll hears it.
 */
async function unbind(): Promise<void> {
  const subId = subOf(currentId()) ?? state.subscriptions[0]?.id
  if (!subId || unbound.has(subId)) return
  unbound.add(subId)
  const id = state.activeId
  if (!id || subOf(id) !== subId || state.states[id]?.status !== 'up') {
    await wait(1500)
    if (unbound.has(subId)) revoke(subId)
    return
  }
  const was = state.states[id]
  setState({ states: setTunnel(id, { ...was, stats: was.stats && { ...was.stats, lastHandshakeSec: 180 } }) })
  logLine(WARN.level, WARN.source, WARN.message)
  await wait(2500)
  if (!unbound.has(subId) || state.activeId !== id) return
  if (platform === 'mac') return revoke(subId)
  // Windows and Linux: the tunnel may be what cuts the request off, so it goes down for that one exchange.
  const name = state.subscriptions.find((s) => s.id === subId)?.name ?? ''
  logLine('info', 'app', `Мастер-ключ «${name}»: туннель мешает запросу настроек — отключаю его на время запроса`)
  setState({ busy: true, activeId: null, states: setTunnel(id, { id, status: 'down' }) })
  await wait(700)
  // Gone with its servers: nothing to bring back up.
  revoke(subId)
}

function currentId(): string | null {
  let last: string | null = null
  try {
    last = localStorage.getItem('awg:lastTunnel')
  } catch {
    /* the first server */
  }
  return (state.tunnels.find((t) => t.id === (state.activeId ?? last)) ?? state.tunnels[0])?.id ?? null
}

// ——— Journal ———

const logs: LogEntry[] = []
const logListeners = new Set<(entries: LogEntry[]) => void>()
let logId = 0
const LINES: { level: LogLevel; source: LogSource; message: string }[] = [
  { level: 'info', source: 'app', message: 'Проверка обновлений: новее нет' },
  { level: 'info', source: 'app', message: 'Мастер-ключ «Семья»: настройки актуальны' },
  { level: 'debug', source: 'app', message: 'Настройки интерфейса сохранены' },
  { level: 'info', source: 'tunnel', message: 'Рукопожатие с 185.12.34.56:51820' },
  { level: 'debug', source: 'tunnel', message: 'peer(Qm9v…): отправлен keepalive' },
  { level: 'info', source: 'tunnel', message: 'Маршрут до сервера через en0 (192.168.1.1)' },
  { level: 'info', source: 'tunnel', message: 'DNS: 1.1.1.1, 1.0.0.1' }
]
const WARN = { level: 'warn' as const, source: 'tunnel' as const, message: 'Рукопожатие не пришло за 15 с, повторяю' }
const ERROR = { level: 'error' as const, source: 'tunnel' as const, message: 'Сервер не отвечает: таймаут UDP к 185.12.34.56:51820' }
function logLine(level: LogLevel, source: LogSource, message: string): void {
  const entry: LogEntry = { id: ++logId, ts: Date.now(), level, source, message }
  logs.push(entry)
  logListeners.forEach((cb) => cb([entry]))
}
function pushLogs(count: number, level?: 'info' | 'warn' | 'error'): void {
  const batch: LogEntry[] = []
  for (let i = 0; i < count; i++) {
    const line = level === 'warn' ? WARN : level === 'error' ? ERROR : LINES[(logId + i) % LINES.length]
    batch.push({ id: ++logId, ts: Date.now(), ...line })
  }
  logs.push(...batch)
  logListeners.forEach((cb) => cb(batch))
}
pushLogs(12)
let stream: ReturnType<typeof setInterval> | null = null

// ——— Theme: the page follows prefers-color-scheme only, so the lab rewrites those media rules ———

let theme: LabTheme = 'system'
const original = new WeakMap<CSSMediaRule, string>()
function applyTheme(): void {
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSMediaRule)) continue
      const text = original.get(rule) ?? rule.media.mediaText
      if (!text.includes('prefers-color-scheme')) continue
      original.set(rule, text)
      const forDark = text.includes('dark')
      rule.media.mediaText = theme === 'system' ? text : (theme === 'dark') === forDark ? 'all' : 'not all'
    }
  }
}
// Vite adds and replaces style elements as modules load and change.
new MutationObserver(() => theme !== 'system' && applyTheme()).observe(document.head, { childList: true, subtree: true, characterData: true })

// ——— Master key devices ———

const DEVICE_POOL: Omit<KeyDevice, 'id' | 'current'>[] = [
  { name: platform === 'win' ? 'Windows-ПК' : platform === 'linux' ? 'artix' : 'MacBook Ивана', platform: platform === 'win' ? 'windows' : platform === 'linux' ? 'linux' : 'macos', version: BUILD, createdAt: 9, lastSeen: 240 },
  { name: 'Pixel 8', platform: 'android', version: '', createdAt: 30, lastSeen: 3 * 3600 },
  { name: 'iPhone', platform: 'ios', version: '1.2.0', createdAt: 60, lastSeen: null },
  { name: 'Рабочий ноутбук с очень длинным именем устройства', platform: 'windows', version: '0.6.2', createdAt: 120, lastSeen: 86400 * 20 },
  { name: 'Сервер дома', platform: 'linux', version: '0.7.0', createdAt: 200, lastSeen: 60 },
  { name: 'iPad', platform: 'ios', version: '1.1.0', createdAt: 300, lastSeen: 86400 * 2 }
]

// ——— Notifications ———

// The page starts as the application does: with the beta notice, shown while there is a «Профиль».
let notices: AppNotice[] = [BETA_NOTICE]
let noticeSerial = 0
/** What MA7 has said since the last look; `refreshNotices` brings it over. */
let onServer: LabNotice[] = []
const shownNotices = (): AppNotice[] => notices.filter((n) => n.id !== BETA_NOTICE.id || hasProfile())
const setNotices = (next: AppNotice[]): void => {
  notices = next
  noticeListeners.forEach((cb) => cb(shownNotices()))
}
const NOTICES: Record<LabNotice, Omit<AppNotice, 'id' | 'at'>> = {
  ending: {
    tone: 'warn',
    priority: 'high',
    title: 'Подписка заканчивается через 2 дня',
    text: 'Оплатите заранее, чтобы VPN не отключился.',
    action: { label: 'Оплатить', view: 'profile' },
    dismissible: true
  },
  overdue: {
    tone: 'error',
    priority: 'high',
    title: 'Подписка просрочена',
    text: 'Баланса не хватило на продление. Уведомление уйдёт само, когда оплата пройдёт.',
    action: { label: 'Оплатить', view: 'profile' },
    dismissible: false
  },
  paid: { tone: 'success', priority: 'low', title: 'Оплата подтверждена', text: 'Подписка продлена до 28 октября.', dismissible: true },
  announce: {
    tone: 'info',
    priority: 'normal',
    title: 'Технические работы',
    text: 'Сегодня с 02:00 до 03:00 МСК сервер «Германия» будет недоступен. Остальные работают как обычно.',
    dismissible: true
  },
  device: {
    tone: 'info',
    priority: 'low',
    title: 'Новое устройство',
    text: 'К ключу «Семья» подключился iPhone.',
    action: { label: 'Открыть ключ', view: 'key' },
    dismissible: true
  },
  unbound: {
    tone: 'warn',
    priority: 'normal',
    title: 'Лимит устройств уменьшен',
    text: 'От ключа «Семья» отвязаны iPad и Pixel 8.',
    action: { label: 'Открыть ключ', view: 'key' },
    dismissible: true
  }
}

// ——— The bridge ———

let ui: UiSettings = { ...UI_DEFAULTS }
let autoStart = false
let macServiceRemoved = false
const progressListeners = new Set<(e: SetupProgress) => void>()
const failedListeners = new Set<(e: SetupFailure) => void>()
const NOTES = ['Лаборатория интерфейса', 'Состояния можно переключать с панели справа']
const TOTAL = 118_000_000

async function download(): Promise<void> {
  for (let received = 0; received < TOTAL; received += TOTAL / 20) {
    setUpdateState({ kind: 'downloading', version: NEXT, notes: NOTES, received, total: TOTAL })
    await wait(120)
  }
  setUpdateState({ kind: 'ready', version: NEXT, notes: NOTES })
}

function showUpdated(): void {
  updatedListeners.forEach((cb) => cb(globals.__APP_VERSION__))
}

const api: AwgApi = {
  getState: async () => state,
  onState: (cb) => {
    stateListeners.add(cb)
    return () => stateListeners.delete(cb)
  },
  previewLink: async (link) => {
    await wait(150)
    const text = link.trim()
    if (/^sen:\/\//i.test(text)) return { ok: true, master: { name: 'Офис', address: '192.0.2.50:40123', tls: text.includes('tls') } }
    if (!/^vpn:\/\//i.test(text)) return { ok: false, error: 'Это не ключ: нужна ссылка vpn:// или sen://' }
    if (cfg().importLink === 'error') return { ok: false, error: 'Ключ повреждён: не удалось прочитать настройки' }
    return { ok: true, tunnel: server('Новый сервер', '192.0.2.77:51820') }
  },
  importLink: async (link, name) => {
    await wait(900)
    const text = link.trim()
    if (cfg().importLink === 'error') return { ok: false, error: 'Ключ повреждён: не удалось прочитать настройки' }
    if (/^sen:\/\//i.test(text)) {
      if (state.subscriptions.some((s) => s.id === 'office')) return { ok: false, error: 'Этот мастер-ключ уже добавлен' }
      const login = /#(ma7_\w+)/.exec(text)?.[1]
      const added = [server('Офис', '192.0.2.50:47619', { subId: 'office', serverId: 0 }), server('Офис · резерв', '192.0.2.51:443', { subId: 'office', serverId: 1 })]
      setState({
        tunnels: [...state.tunnels, ...added],
        states: { ...state.states, ...Object.fromEntries(added.map((t) => [t.id, { id: t.id, status: 'down' as const }])) },
        subscriptions: [
          ...state.subscriptions,
          { ...masterKey('office', 'Офис', 'ok', login), plain: !text.includes('tls'), checkedAt: Date.now() }
        ],
        accounts: login && !state.accounts.includes(login) ? [...state.accounts, login] : state.accounts
      })
      return { ok: true, tunnel: added[0], bindings: { used: Math.min(cfg().deviceCount + 1, cfg().deviceLimit), limit: cfg().deviceLimit } }
    }
    if (!/^vpn:\/\//i.test(text)) return { ok: false, error: 'Это не ключ: нужна ссылка vpn:// или sen://' }
    const tunnel = server(name?.trim() || `Сервер ${state.tunnels.length + 1}`, '192.0.2.77:51820')
    setState({ tunnels: [...state.tunnels, tunnel], states: setTunnel(tunnel.id, { id: tunnel.id, status: 'down' }) })
    return { ok: true, tunnel }
  },
  removeTunnel: async (id) => {
    await wait(300)
    const subId = state.tunnels.find((t) => t.id === id)?.source?.subId
    const gone = new Set(state.tunnels.filter((t) => t.id === id || (subId && t.source?.subId === subId)).map((t) => t.id))
    setState({
      tunnels: state.tunnels.filter((t) => !gone.has(t.id)),
      states: Object.fromEntries(Object.entries(state.states).filter(([k]) => !gone.has(k))),
      activeId: state.activeId && gone.has(state.activeId) ? null : state.activeId,
      subscriptions: subId ? state.subscriptions.filter((s) => s.id !== subId) : state.subscriptions
    })
  },
  refreshSubscription: async (id) => {
    await wait(900)
    if (unbound.has(id)) return revoke(id)
    setState({ subscriptions: state.subscriptions.map((s) => (s.id === id ? { ...s, status: cfg().refresh, checkedAt: cfg().refresh === 'offline' ? s.checkedAt : Date.now() } : s)) })
  },
  peekKey: async () => {
    await wait(500)
    return cfg().devices === 'error' ? null : { used: cfg().deviceCount, limit: cfg().deviceLimit }
  },
  getKeyDevices: async (id) => {
    const c = cfg()
    await wait(c.devices === 'slow' ? 3000 : 400)
    if (unbound.has(id)) {
      revoke(id)
      throw new Error('Сервер не узнал это устройство')
    }
    if (c.devices === 'error') throw new Error('Сервер ключа не отвечает')
    const sec = Math.floor(Date.now() / 1000)
    return {
      limit: c.deviceLimit,
      devices: DEVICE_POOL.slice(0, Math.max(1, c.deviceCount)).map((d, i) => ({
        ...d,
        id: i + 1,
        current: i === 0,
        createdAt: sec - 86400 * d.createdAt,
        lastSeen: d.lastSeen === null ? null : sec - d.lastSeen
      }))
    }
  },
  removeSubscription: async (id) => {
    await wait(900)
    const gone = new Set(state.tunnels.filter((t) => t.source?.subId === id).map((t) => t.id))
    setState({
      tunnels: state.tunnels.filter((t) => !gone.has(t.id)),
      activeId: state.activeId && gone.has(state.activeId) ? null : state.activeId,
      subscriptions: state.subscriptions.filter((s) => s.id !== id)
    })
  },
  getProfile: async (login) => {
    const c = cfg()
    await wait(c.profile === 'slow' ? 3000 : 500)
    if (c.profile === 'error') throw new Error('Нет связи с MA7')
    if (c.profile === 'notfound') throw new Error(`MA7 не знает логин ${login}`)
    return {
      login,
      status: c.profileStatus,
      paidUntil: c.profileStatus === 'unpaid' ? null : Date.now() + c.profileDays * 86_400_000 - 3_600_000,
      balance: c.balance,
      monthly: c.monthly,
      keys: c.profileKeys
    }
  },
  logoutProfile: async (login) => {
    await wait(400)
    setState({
      accounts: state.accounts.filter((l) => l !== login),
      subscriptions: state.subscriptions.map((s) => {
        if (s.login !== login) return s
        const { login: _gone, ...rest } = s
        return rest
      })
    })
  },
  applyPromo: async () => {
    const c = cfg()
    await wait(700)
    if (c.promo === 'error') throw new Error('Нет связи с MA7')
    if (c.promo === 'invalid') return { ok: false, error: 'Промокод не найден.' }
    if (c.promo === 'used') return { ok: false, error: 'Вы уже использовали этот промокод.' }
    return { ok: true, discount: { kind: 'rubles', value: 50, perDevice: false } }
  },
  // Made-up requisites: the real ones come from MA7, never from the application.
  getNotices: async () => shownNotices(),
  onNotices: (cb) => {
    noticeListeners.add(cb)
    return () => noticeListeners.delete(cb)
  },
  dismissNotice: async (id) => setNotices(notices.filter((n) => n.id !== id)),
  refreshNotices: async () => {
    await new Promise((r) => setTimeout(r, 900))
    const fresh = onServer
    onServer = []
    if (fresh.length) setNotices([...notices, ...fresh.map((kind) => ({ ...NOTICES[kind], id: `lab-${++noticeSerial}`, at: Date.now() }))])
  },
  getPaymentDetails: async () => {
    const c = cfg()
    await wait(c.payment === 'slow' ? 3000 : 400)
    if (c.payment === 'error') throw new Error('Нет связи с MA7')
    return { bank: 'Т-Банк', phone: '+7 900 000-00-00', recipient: 'Иван И.' }
  },
  confirmPayment: async () => {
    const c = cfg()
    await wait(800)
    if (c.paid === 'error') throw new Error('Не удалось отправить заявку. Попробуйте позже')
    // As MA7 would: the account waits for the admin. The panel's own switch shows it next time it redraws.
    c.profileStatus = 'processing'
  },
  connect: async (id) => {
    const previous = state.activeId
    setState({ busy: true, switching: previous !== null && previous !== id, activeId: id, states: setTunnel(id, { id, status: 'connecting' }) })
    await wait(1200)
    const c = cfg()
    const done = { busy: false, switching: false, needsCleanup: false }
    switch (c.connect) {
      case 'ok':
        state = { ...state, states: othersDown(id) }
        setState({ ...done, degraded: null, states: setTunnel(id, upOrDead(id)), subscriptions: state.subscriptions.map((s) => ({ ...s, pendingRev: false })) })
        pushLogs(2)
        return
      case 'error':
        pushLogs(1, 'error')
        setState({ ...done, activeId: null, states: setTunnel(id, { id, status: 'error', error: c.connectError }, othersDown(null)) })
        return
      case 'cancel':
        setState({ ...done, activeId: previous, states: setTunnel(id, { id, status: 'down' }) })
        return
      case 'throw':
        setState({ ...done, activeId: previous, states: setTunnel(id, { id, status: 'down' }) })
        throw new Error(`Error invoking remote method 'tunnel:connect': Error: ${c.connectError}`)
    }
  },
  disconnect: async (id) => {
    setState({ busy: true })
    await wait(700)
    setState({ busy: false, activeId: null, degraded: null, states: setTunnel(id, { id, status: 'down' }) })
  },
  reconnect: async () => {
    const id = state.activeId
    if (!id) return
    setState({ busy: true, states: setTunnel(id, { id, status: 'connecting' }) })
    await wait(1200)
    setState({ busy: false, degraded: null, states: setTunnel(id, upOrDead(id)), subscriptions: state.subscriptions.map((s) => ({ ...s, pendingRev: false })) })
  },
  copyEndpoint: async () => undefined,
  ping: async () => {
    const answer = cfg().ping
    await wait(answer === 'slow' ? 1500 : 600)
    return answer === 'fast' ? 38 : answer === 'slow' ? 412 : null
  },
  getAppOptions: async () => {
    const c = cfg()
    return { supported: c.optionsSupported, canUninstall: c.canUninstall, autoStart, canRunInBackground: c.canRunInBackground }
  },
  setAutoStart: async (on) => {
    await wait(400)
    if (cfg().autoStart === 'ok') autoStart = on
    return autoStart
  },
  uninstall: async () => {
    const c = cfg()
    await wait(1200)
    if (c.uninstall === 'cancelled') return 'cancelled'
    for (let step = 0; step < 3; step++) {
      progressListeners.forEach((cb) => cb({ step, state: 'active' }))
      await wait(1100)
      if (c.uninstall === 'failed' && step === 1) {
        failedListeners.forEach((cb) => cb({ step, message: 'Не удалось удалить службу: доступ запрещён' }))
        return 'failed'
      }
      progressListeners.forEach((cb) => cb({ step, state: 'done' }))
    }
    return 'done'
  },
  onUninstallProgress: (cb) => {
    progressListeners.add(cb)
    return () => progressListeners.delete(cb)
  },
  onUninstallFailed: (cb) => {
    failedListeners.add(cb)
    return () => failedListeners.delete(cb)
  },
  // The application would close: here it starts over.
  finishUninstall: async () => location.reload(),
  getMacService: async () => {
    const kind = cfg().macService
    if (kind === 'none') return null
    if (macServiceRemoved) return { installed: false }
    if (kind === 'silent') return { installed: true }
    return { installed: true, version: kind === 'current' ? BUILD : '0.6.9', current: kind === 'current' }
  },
  removeMacService: async () => {
    if (state.activeId) throw new Error('Сначала отключите VPN')
    await wait(1000)
    const result = cfg().macServiceRemove
    if (result === 'error') throw new Error('launchctl bootout завершился с ошибкой 5')
    if (result === 'done') macServiceRemoved = true
    return result
  },
  cleanup: async () => {
    setState({ busy: true })
    await wait(800)
    setState({ busy: false, needsCleanup: false })
  },
  setDiagnostics: async (enabled) => setState({ diagnostics: enabled }),
  getAbout: async () => ({ app: `dev-${globals.__APP_VERSION__}-${platform}`, engine: 'amneziawg-go v3.1 (лаборатория)' }),
  getPywal: async () => ({
    background: '#0f1a24',
    foreground: '#d6e2ee',
    colors: ['#0f1a24', '#c4586b', '#5fae8a', '#d9b45f', '#5a8fd6', '#a371d1', '#4fb3c4', '#d6e2ee', '#506070', '#e07a8c', '#7fcfa8', '#f0cc7a', '#7aaaf0', '#bf92ee', '#74cddb', '#ffffff']
  }),
  getUiSettings: async () => ui,
  setUiSettings: async (patch) => (ui = { ...ui, ...patch }),
  getLogs: async () => logs,
  clearLogs: async () => void logs.splice(0),
  copyLogs: async () => undefined,
  onLogs: (cb) => {
    logListeners.add(cb)
    return () => logListeners.delete(cb)
  },
  update: {
    getUpdate: async () => update,
    onUpdate: (cb) => {
      updateListeners.add(cb)
      return () => updateListeners.delete(cb)
    },
    async checkForUpdate() {
      setUpdateState({ kind: 'checking' })
      await wait(1200)
      const found = cfg().updateCheck
      if (found === 'latest') return setUpdateState({ kind: 'idle', checkedAt: Date.now() })
      if (found === 'network') return setUpdateState({ kind: 'failed', reason: 'network', message: 'Нет связи с сервером обновлений' })
      if (ui.autoUpdate) return download()
      setUpdateState({ kind: 'available', version: NEXT, notes: NOTES, total: TOTAL })
    },
    async downloadUpdate() {
      if (update.kind === 'available') await download()
    },
    // The application would quit and come back as the new version: here it just becomes it.
    async installUpdate() {
      setUpdateState({ kind: 'installing', version: NEXT })
      await wait(2500)
      globals.__APP_VERSION__ = NEXT
      setUpdateState({ kind: 'idle', checkedAt: Date.now() })
      showUpdated()
    },
    onUpdated: (cb) => {
      updatedListeners.add(cb)
      return () => updatedListeners.delete(cb)
    }
  }
}

// ——— The panel's handle ———

function updateState(kind: LabUpdate): UpdateState {
  switch (kind) {
    case 'idle':
      return { kind: 'idle', checkedAt: Date.now() - 3 * 3_600_000 }
    case 'idle-never':
      return { kind: 'idle', checkedAt: null }
    case 'checking':
      return { kind: 'checking' }
    case 'available':
      return { kind: 'available', version: NEXT, notes: NOTES, total: TOTAL }
    case 'downloading':
      return { kind: 'downloading', version: NEXT, notes: NOTES, received: TOTAL * 0.42, total: TOTAL }
    case 'ready':
      return { kind: 'ready', version: NEXT, notes: NOTES }
    case 'ready-declined':
      return { kind: 'ready', version: NEXT, notes: NOTES, message: 'Установка отменена: пароль администратора не введён' }
    case 'installing':
      return { kind: 'installing', version: NEXT }
    case 'failed-network':
      return { kind: 'failed', reason: 'network', message: 'Нет связи с сервером обновлений' }
    case 'failed-installing':
      return { kind: 'failed', reason: 'network', installing: true, message: 'Образ обновления повреждён, он будет скачан заново' }
    case 'failed-revoked':
      return { kind: 'failed', reason: 'revoked', message: 'Эта версия отозвана. Скачайте новую с сайта' }
    case 'unsupported':
      return { kind: 'failed', reason: 'unsupported', message: 'Эта копия собрана не нами — обновления для неё не предлагаются' }
  }
}

const control: LabControl = {
  state: () => state,
  currentId,
  setStatus(status, error) {
    const id = currentId()
    if (!id) return
    if (status === 'down') {
      setState({ busy: false, switching: false, activeId: state.activeId === id ? null : state.activeId, states: setTunnel(id, { id, status }) })
    } else if (status === 'error') {
      setState({ busy: false, switching: false, activeId: null, states: setTunnel(id, { id, status, error: error || cfg().connectError }, othersDown(null)) })
    } else {
      state = { ...state, states: othersDown(id) }
      setState({ activeId: id, states: setTunnel(id, status === 'up' ? upState(id) : { id, status }) })
    }
  },
  patch: (patch) => setState(patch),
  setTraffic(next) {
    traffic = next
    const id = state.activeId
    if (id && state.states[id]?.status === 'up' && !unbound.has(subOf(id) ?? '')) setState({ states: setTunnel(id, upState(id)) })
  },
  setSub(patch) {
    const id = currentId()
    const subId = subOf(id) ?? state.subscriptions[0]?.id
    // «Активен» from the panel: the server knows the device again.
    if (subId && patch.status === 'ok') unbound.delete(subId)
    // A login put on the key or taken off it brings the account or takes it away, as pasting the link would.
    const old = state.subscriptions.find((s) => s.id === subId)?.login
    const accounts =
      patch.login === undefined || !subId
        ? state.accounts
        : [...new Set([...state.accounts.filter((l) => l !== old), ...(patch.login ? [patch.login] : [])])]
    setState({
      accounts,
      subscriptions: state.subscriptions.map((s) => {
        if (s.id !== subId) return s
        const next = { ...s, ...patch, checkedAt: patch.status === 'offline' ? s.checkedAt : Date.now() }
        // An empty login takes it away, as a link without «#ma7_…» would.
        if (next.login === '') delete next.login
        return next
      })
    })
  },
  unbind,
  setUpdate: (kind) => setUpdateState(updateState(kind)),
  showUpdated,
  pushNotice: (kind) => setNotices([...notices, { ...NOTICES[kind], id: `lab-${++noticeSerial}`, at: Date.now() }]),
  clearNotices: () => setNotices([]),
  serverNotice: (kind) => void onServer.push(kind),
  addLogs: pushLogs,
  streamLogs(on) {
    if (stream) clearInterval(stream)
    stream = on ? setInterval(() => pushLogs(1, Math.random() < 0.1 ? 'warn' : undefined), 700) : null
  },
  setTheme(next) {
    theme = next
    applyTheme()
  },
  onChange(cb) {
    labListeners.add(cb)
    return () => labListeners.delete(cb)
  }
}

window.awg = api
;(window as unknown as { awgLab: LabControl }).awgLab = control
const loaded: LabMessage = { type: 'awg-lab', step: 'loaded' }
if (window.parent !== window) window.parent.postMessage(loaded, location.origin)
