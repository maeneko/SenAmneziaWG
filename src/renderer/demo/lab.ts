/*
 * The UI lab: the application's page in a window (?demo=lab, on src/renderer/src/demo/lab.ts) and a panel that
 * plays the main process — or, in the installer mode, the setup screen (src/renderer/installer, ?lab=1) on its
 * own rehearsal, with the panel in place of its dev bar. The page reads window.awgLabConfig from here at each call, so switches that decide
 * how an action ends apply to the next click; the states themselves go through the page's window.awgLab.
 * Platform and the starting servers need the page opened again, which the panel does itself.
 */
import type { AppState, UpdateState } from '@shared/types'

declare const __BUILD_VERSION__: string
import { labDefaults, type LabConfig, type LabControl, type LabMessage, type LabPlatform, type LabPreset, type LabTheme, type LabTraffic, type LabUpdate } from '../src/demo/labConfig'

type LabPage = 'app' | 'installer'

/**
 * The setup screen's run: a first install, an update asked for, one the application started, a seamless one,
 * the installer opened again over the very same version, or the installed application opened with --maintenance.
 */
type SetupScenario = 'install' | 'update' | 'auto' | 'seamless' | 'installed' | 'maintenance'

interface SetupSaved {
  /** The setup screen exists on Windows and Linux only: macOS installs from the disk image. */
  platform: 'win' | 'linux'
  scenario: SetupScenario
  /** Servers kept from an earlier install: the greeting is «С возвращением!». A first install only. */
  back: boolean
  motion: 'system' | 'full' | 'reduce'
  /** «Обновить» on the «уже установлен» screen: what the site says. */
  update: 'newer' | 'latest' | 'network'
  /** «Удалить» there: how the removal ends. */
  remove: 'done' | 'failed' | 'cancelled'
}

interface Saved {
  page: LabPage
  setup: SetupSaved
  platform: LabPlatform
  preset: LabPreset
  width: number
  height: number
  theme: LabTheme
  cfg: LabConfig
}

const SAVE_KEY = 'awgLab:config'
function load(): Saved {
  const base: Saved = {
    page: 'app',
    setup: { platform: 'win', scenario: 'install', back: false, motion: 'system', update: 'newer', remove: 'done' },
    platform: 'mac', preset: 'one', width: 420, height: 780, theme: 'system', cfg: labDefaults('mac') }
  try {
    const saved = JSON.parse(localStorage.getItem(SAVE_KEY) ?? 'null') as Partial<Saved> | null
    if (!saved) return base
    const platform = saved.platform ?? base.platform
    return { ...base, ...saved, setup: { ...base.setup, ...saved.setup }, cfg: { ...labDefaults(platform), ...saved.cfg } }
  } catch {
    return base
  }
}
const saved = load()
const save = (): void => {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(saved))
  } catch {
    /* the panel still works, it just forgets */
  }
}
// The page reads this object — the same one, changed in place — from its parent.
;(window as unknown as { awgLabConfig: LabConfig }).awgLabConfig = saved.cfg

const win = document.getElementById('win') as HTMLDivElement
const frame = document.getElementById('app') as HTMLIFrameElement
const panel = document.getElementById('panel') as HTMLElement
const sizeLabel = document.getElementById('size-label') as HTMLParagraphElement
const winName = win.querySelector('.win-name') as HTMLSpanElement

const lab = (): LabControl | null => {
  try {
    return (frame.contentWindow as unknown as { awgLab?: LabControl } | null)?.awgLab ?? null
  } catch {
    return null
  }
}
/** What installer.js gives the dev bar in a browser (`window.__setupPreview`). */
interface SetupPreview {
  burst(): void
  failNow(): void
  cancelNow(): void
  passwordNow(): void
  finishNow(): void
  setSpeed(value: number): void
}
const setupPreview = (): SetupPreview | null => {
  if (saved.page !== 'installer') return null
  try {
    return (frame.contentWindow as unknown as { __setupPreview?: SetupPreview } | null)?.__setupPreview ?? null
  } catch {
    return null
  }
}
let setupLoaded = false
let live: { state: AppState | null; update: UpdateState | null } = { state: null, update: null }
let traffic: LabTraffic = 'some'
let streaming = false

// ——— The page ———

function open(extra: Record<string, string> = {}): void {
  live = { state: null, update: null }
  streaming = false
  setupLoaded = false
  winName.textContent = 'SenAWG'
  if (saved.page === 'installer') {
    // What the bridge would say in the app, said through the address (installer.js, `query`).
    const { platform, scenario, back, motion, update, remove } = saved.setup
    const q = new URLSearchParams({ lab: '1', platform, speed: String(saved.cfg.speed), update, remove })
    if (scenario !== 'install') q.set('mode', 'update')
    if (scenario === 'installed') q.set('already', '1')
    if (scenario === 'maintenance') q.set('maintenance', '1')
    q.set('version', typeof __BUILD_VERSION__ === 'string' ? __BUILD_VERSION__ : '0.0.0')
    if (scenario === 'auto' || scenario === 'seamless') q.set('auto', '1')
    if (scenario === 'seamless') q.set('seamless', '1')
    if (scenario === 'install' && back) q.set('back', '1')
    if (motion !== 'system') q.set('motion', motion)
    frame.src = `/installer/index.html?${q}`
  } else {
    const q = new URLSearchParams({ demo: 'lab', platform: saved.platform, preset: saved.preset, ...extra })
    frame.src = `/index.html?${q}`
  }
  syncAll()
}

/**
 * The setup screen knows nothing of the lab's theme switch: its stylesheets are turned here, the way the
 * application's page turns its own (applyTheme in src/renderer/src/demo/lab.ts).
 */
const setupMedia = new WeakMap<CSSMediaRule, string>()
function themeSetup(): void {
  const doc = frame.contentDocument
  if (!doc) return
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof (frame.contentWindow as unknown as typeof window).CSSMediaRule)) continue
      const media = rule as CSSMediaRule
      const text = setupMedia.get(media) ?? media.media.mediaText
      if (!text.includes('prefers-color-scheme')) continue
      setupMedia.set(media, text)
      const forDark = text.includes('dark')
      media.media.mediaText = saved.theme === 'system' ? text : (saved.theme === 'dark') === forDark ? 'all' : 'not all'
    }
  }
}

function setupReady(): void {
  const doc = frame.contentDocument
  if (!doc) return
  setupLoaded = true
  themeSetup()
  // The window is «Установка SenAWG» until the screen becomes the application.
  const title = doc.querySelector('title')
  winName.textContent = doc.title
  if (title) new MutationObserver(() => (winName.textContent = doc.title)).observe(title, { childList: true })
  syncAll()
}

window.addEventListener('message', (e: MessageEvent) => {
  const data = e.data as Partial<LabMessage>
  if (e.origin !== location.origin || data?.type !== 'awg-lab' || data.step !== 'loaded') return
  if (saved.page === 'installer') return setupReady()
  const control = lab()
  if (!control) return
  control.setTheme(saved.theme)
  control.setTraffic(traffic)
  live = { state: control.state(), update: null }
  control.onChange((state, update) => {
    live = { state, update }
    syncAll()
  })
  syncAll()
})

// ——— The window ———

const TITLE_BAR = 32
/** The system the window stands for: the setup screen keeps its own. */
const chrome = (): LabPlatform => (saved.page === 'installer' ? saved.setup.platform : saved.platform)
const titleBar = (): number => (chrome() === 'mac' ? 0 : TITLE_BAR)
function applyWindow(): void {
  win.dataset.platform = chrome()
  win.style.width = `${saved.width}px`
  win.style.height = `${saved.height + titleBar()}px`
  sizeLabel.textContent = `${saved.width} × ${saved.height}`
}
// The corner handle: the window is resized by hand like a real one.
new ResizeObserver(() => {
  const width = Math.round(win.offsetWidth)
  const height = Math.round(win.offsetHeight) - titleBar()
  if (width === saved.width && height === saved.height) return
  saved.width = width
  saved.height = height
  sizeLabel.textContent = `${width} × ${height}`
  save()
  syncAll()
}).observe(win)

// ——— Controls ———

const syncs: (() => void)[] = []
function syncAll(): void {
  syncs.forEach((s) => s())
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}

/** `only`: the section belongs to one of the pages the window shows, and hides with the other. */
function section(title: string, hint?: string, only?: LabPage): HTMLElement {
  const body = el('div', { className: 'section-body' })
  if (hint) body.append(el('p', { className: 'hint' }, hint))
  const details = el('details', { className: 'section', open: true }, el('summary', {}, title), body)
  const key = `awgLab:closed:${title}`
  try {
    details.open = localStorage.getItem(key) !== '1'
  } catch {
    /* open */
  }
  details.addEventListener('toggle', () => {
    try {
      localStorage.setItem(key, details.open ? '0' : '1')
    } catch {
      /* remembered for this visit only */
    }
  })
  if (only) syncs.push(() => (details.hidden = saved.page !== only))
  panel.append(details)
  return body
}

/** A row that belongs to one page only. */
function only(page: LabPage, r: HTMLElement): HTMLElement {
  syncs.push(() => (r.hidden = saved.page !== page))
  return r
}

function row(parent: HTMLElement, label: string, ...controls: Node[]): HTMLElement {
  const r = el('div', { className: 'row' }, el('span', { className: 'label' }, label), el('div', { className: 'controls' }, ...controls))
  parent.append(r)
  return r
}

function button(text: string, onClick: () => void, pressed?: () => boolean, disabled?: () => boolean): HTMLButtonElement {
  const b = el('button', { type: 'button', textContent: text })
  b.addEventListener('click', () => {
    onClick()
    syncAll()
  })
  if (pressed || disabled) {
    syncs.push(() => {
      if (pressed) b.setAttribute('aria-pressed', String(pressed()))
      if (disabled) b.disabled = disabled()
    })
  }
  return b
}

/** A row of mutually exclusive buttons. */
function seg<T>(options: [T, string][], isOn: (v: T) => boolean, pick: (v: T) => void, disabled?: () => boolean): Node[] {
  return options.map(([value, text]) => button(text, () => pick(value), () => isOn(value), disabled))
}

/** A LabConfig field chosen among values: applies to the next call the page makes. */
function cfgSeg<K extends keyof LabConfig>(key: K, options: [LabConfig[K], string][]): Node[] {
  return seg(options, (v) => saved.cfg[key] === v, (v) => {
    saved.cfg[key] = v
    save()
  })
}

function check(text: string, get: () => boolean, set: (on: boolean) => void, disabled?: () => boolean): HTMLLabelElement {
  const input = el('input', { type: 'checkbox' })
  input.addEventListener('change', () => {
    set(input.checked)
    syncAll()
  })
  syncs.push(() => {
    input.checked = get()
    input.disabled = disabled?.() ?? false
  })
  return el('label', { className: 'check' }, input, text)
}

function number(get: () => number, set: (n: number) => void, min: number, max: number): HTMLInputElement {
  const input = el('input', { type: 'number', min: String(min), max: String(max), className: 'num' })
  input.addEventListener('change', () => {
    const raw = Math.round(Number(input.value))
    const n = Math.min(max, Math.max(min, Number.isFinite(raw) ? raw : min))
    set(n)
    syncAll()
  })
  syncs.push(() => {
    if (document.activeElement !== input) input.value = String(get())
  })
  return input
}

function text(get: () => string, set: (s: string) => void, placeholder = ''): HTMLInputElement {
  const input = el('input', { type: 'text', placeholder, className: 'text' })
  input.addEventListener('input', () => set(input.value))
  syncs.push(() => {
    if (document.activeElement !== input) input.value = get()
  })
  return input
}

const noLab = (): boolean => lab() === null || live.state === null
const current = (): { id: string; name: string; status: string; sub?: AppState['subscriptions'][number] } | null => {
  const control = lab()
  const state = live.state
  if (!control || !state) return null
  const id = control.currentId()
  const tunnel = state.tunnels.find((t) => t.id === id)
  if (!tunnel) return null
  const subId = tunnel.source?.subId
  return {
    id: tunnel.id,
    name: tunnel.name,
    status: state.states[tunnel.id]?.status ?? 'down',
    sub: state.subscriptions.find((s) => s.id === subId) ?? state.subscriptions[0]
  }
}

// ——— Окно ———

{
  const s = section('Окно')
  row(
    s,
    'Показать',
    ...seg<LabPage>([['app', 'Приложение'], ['installer', 'Установщик']], (v) => saved.page === v, (v) => {
      if (saved.page === v) return
      saved.page = v
      save()
      applyWindow()
      open()
    })
  )
  only(
    'installer',
    row(
      s,
      'Платформа',
      ...seg<SetupSaved['platform']>([['win', 'Windows'], ['linux', 'Linux']], (v) => saved.setup.platform === v, (v) => {
        saved.setup.platform = v
        save()
        applyWindow()
        open()
      })
    )
  )
  only(
    'app',
    row(
      s,
      'Платформа',
      ...seg<LabPlatform>([['mac', 'macOS'], ['win', 'Windows'], ['linux', 'Linux']], (v) => saved.platform === v, (v) => {
        saved.platform = v
        // What the system allows goes with the platform; how actions end stays as chosen.
        const d = labDefaults(v)
        Object.assign(saved.cfg, { canUninstall: d.canUninstall, canRunInBackground: d.canRunInBackground, macService: d.macService })
        save()
        applyWindow()
        open()
      })
    )
  )
  const SIZES: [[number, number], string][] = [
    [[420, 780], '420×780'],
    [[360, 640], '360×640'],
    [[760, 720], '760×720'],
    [[1180, 800], '1180×800']
  ]
  row(
    s,
    'Размер',
    ...seg(SIZES, ([w, h]) => saved.width === w && saved.height === h, ([w, h]) => {
      saved.width = w
      saved.height = h
      save()
      applyWindow()
    })
  )
  row(
    s,
    'Свой',
    number(() => saved.width, (n) => ((saved.width = n), save(), applyWindow()), 280, 2400),
    el('span', { className: 'times' }, '×'),
    number(() => saved.height, (n) => ((saved.height = n), save(), applyWindow()), 300, 1600),
    el('span', { className: 'hint' }, 'или тяните за угол окна')
  )
  row(
    s,
    'Тема',
    ...seg<LabTheme>([['system', 'Как в системе'], ['light', 'Светлая'], ['dark', 'Тёмная']], (v) => saved.theme === v, (v) => {
      saved.theme = v
      save()
      lab()?.setTheme(v)
      if (setupLoaded) themeSetup()
    })
  )
  row(
    s,
    'Скорость',
    ...seg<number>([[0.25, '×¼'], [0.5, '×½'], [1, '×1'], [2, '×2'], [5, '×5']], (v) => saved.cfg.speed === v, (v) => {
      saved.cfg.speed = v
      save()
      // The rehearsal reads it when a run starts: the next button in «Установщик» plays at it.
      setupPreview()?.setSpeed(v)
    })
  )
  const restart = button('', () => open())
  syncs.push(() => (restart.textContent = saved.page === 'installer' ? 'Открыть установщик заново' : 'Перезапустить приложение'))
  row(s, '', restart)
}

// ——— Установщик ———

{
  const s = section(
    'Установщик',
    'Экран установки Windows и Linux (src/renderer/installer) без главного процесса: шаги идут на выдуманных длительностях.',
    'installer'
  )
  const reopen = (change: (setup: SetupSaved) => void): void => {
    change(saved.setup)
    save()
    open()
  }
  row(
    s,
    'Сценарий',
    ...seg<SetupScenario>(
      [
        ['install', 'Установка'],
        ['update', 'Обновление'],
        ['auto', 'Обновление из приложения'],
        ['seamless', 'Бесшовное'],
        ['installed', 'Уже установлена'],
        ['maintenance', 'Запуск с --maintenance']
      ],
      (v) => saved.setup.scenario === v,
      (v) => reopen((setup) => (setup.scenario = v))
    )
  )
  row(
    s,
    '',
    check(
      'Ключи сохранены («С возвращением!»)',
      () => saved.setup.back,
      (on) => reopen((setup) => (setup.back = on)),
      () => saved.setup.scenario !== 'install'
    )
  )
  s.append(
    el(
      'p',
      { className: 'hint' },
      '«Обновление» спрашивает согласия; «из приложения» — после «Перезапустить и обновить», сразу за работу; ' +
        '«Бесшовное» — поверх только что закрытого приложения: шаги, затем логотип улетает в угол шапки. ' +
        '«Уже установлена» — установщик открыли снова поверх той же версии; «Запуск с --maintenance» — установленное приложение на Linux ' +
        '(`senawg --maintenance`): тот же экран без «Переустановить».'
    )
  )
  const noInstalled = (): boolean => saved.setup.scenario !== 'installed' && saved.setup.scenario !== 'maintenance'
  row(
    s,
    'Обновить найдёт',
    ...seg<SetupSaved['update']>(
      [
        ['newer', 'Новую версию'],
        ['latest', 'Ничего'],
        ['network', 'Нет сети']
      ],
      (v) => saved.setup.update === v,
      (v) => reopen((setup) => (setup.update = v)),
      noInstalled
    )
  )
  row(
    s,
    'Удаление',
    ...seg<SetupSaved['remove']>(
      [
        ['done', 'Удалится'],
        ['failed', 'Сбой на шаге 2'],
        ['cancelled', 'Отказ от прав']
      ],
      (v) => saved.setup.remove === v,
      (v) => reopen((setup) => (setup.remove = v)),
      noInstalled
    )
  )
  s.append(
    el(
      'p',
      { className: 'hint' },
      'Для экрана «уже установлен». Новая версия скачивается с кольцом, затем окно сменяется экраном обновления нового установщика. ' +
        'Удаление идёт как установка наоборот: кольцо убывает, в конце логотип теряет цвет.'
    )
  )
  const noSetup = (): boolean => setupPreview() === null || !setupLoaded
  row(
    s,
    'Сыграть',
    button('Сначала', () => open()),
    button('Быстрая машина', () => setupPreview()?.burst(), undefined, noSetup),
    button('К финалу', () => setupPreview()?.finishNow(), undefined, noSetup)
  )
  const decline = button('', () => setupPreview()?.cancelNow(), undefined, noSetup)
  syncs.push(() => (decline.textContent = saved.setup.platform === 'win' ? 'Отказ от UAC' : 'Отказ от пароля polkit'))
  row(
    s,
    'Как закончится',
    button('Служба не встала', () => setupPreview()?.failNow(), undefined, noSetup),
    decline,
    button('Пароль на экране', () => setupPreview()?.passwordNow(), undefined, () => noSetup() || saved.setup.platform !== 'linux')
  )
  s.append(
    el(
      'p',
      { className: 'hint' },
      '«Быстрая машина» — все шаги отчитываются разом: проверка, что ничего не мелькает. Отказ возвращает к выбору без слов. ' +
        '«Пароль на экране» — Linux без агента polkit: любой пароль принимается, «Отмена» — как отказ.'
    )
  )
  row(
    s,
    'Анимация',
    ...seg<SetupSaved['motion']>(
      [
        ['system', 'Как в системе'],
        ['full', 'Полная'],
        ['reduce', 'Сокращённая']
      ],
      (v) => saved.setup.motion === v,
      (v) => reopen((setup) => (setup.motion = v))
    )
  )
}

// ——— Данные и экраны ———

{
  const s = section('Данные', 'Начальный набор серверов; приложение перезапускается.', 'app')
  row(
    s,
    'Набор',
    ...seg<LabPreset>(
      [
        ['empty', 'Пусто (приветствие)'],
        ['one', 'Один сервер'],
        ['many', 'Много серверов'],
        ['sen', 'Мастер-ключ'],
        ['sen-two', 'Два мастер-ключа'],
        ['account', 'Аккаунт без ключа']
      ],
      (v) => saved.preset === v,
      (v) => {
        saved.preset = v
        save()
        open()
      }
    )
  )
  const go = (view: string, tab?: string): void => {
    try {
      localStorage.setItem('awg:view', view)
      if (tab) localStorage.setItem('awg:settingsTab', tab)
    } catch {
      /* the page opens where it was */
    }
    open()
  }
  row(
    s,
    'Открыть',
    button('Серверы', () => go('tunnels')),
    button('Ключ', () => go('key')),
    button('Профиль', () => go('profile')),
    button('Приложение', () => go('settings', 'app')),
    button('Интерфейс', () => go('settings', 'interface')),
    button('Сеть', () => go('settings', 'network')),
    button('Диагностика', () => go('settings', 'diagnostics'))
  )
  row(
    s,
    'После установки',
    button('Приветствие «С возвращением»', () => {
      if (saved.preset === 'empty' || saved.preset === 'account') saved.preset = 'one'
      save()
      open({ from: 'setup', back: '1' })
    })
  )
}

// ——— Подключение ———

{
  const s = section('Подключение', 'Состояние сервера, который показан на главном экране.', 'app')
  const name = el('span', { className: 'value' })
  syncs.push(() => {
    const c = current()
    name.textContent = c ? c.name : live.state ? 'нет серверов' : 'загрузка…'
  })
  row(s, 'Сервер', name)
  row(
    s,
    'Статус',
    ...seg(
      [
        ['down', 'Выключен'],
        ['connecting', 'Подключение'],
        ['up', 'Подключён'],
        ['error', 'Ошибка']
      ] as const,
      (v) => current()?.status === v,
      (v) => lab()?.setStatus(v, saved.cfg.connectError),
      () => current() === null
    )
  )
  row(s, 'Текст ошибки', text(() => saved.cfg.connectError, (v) => ((saved.cfg.connectError = v), save())))
  const flag = (key: 'busy' | 'switching' | 'needsCleanup' | 'diagnostics', label: string): HTMLLabelElement =>
    check(label, () => Boolean(live.state?.[key]), (on) => lab()?.patch({ [key]: on }), noLab)
  row(s, 'Флаги', flag('busy', 'Занят (busy)'), flag('switching', 'Переключение'))
  row(s, '', flag('needsCleanup', 'Сеть не восстановлена'), flag('diagnostics', 'Диагностика'))
  row(
    s,
    '',
    check(
      'Связь потеряна (degraded)',
      () => Boolean(live.state?.degraded),
      (on) => lab()?.patch({ degraded: on ? 'Маршрут до сервера потерян — трафик не идёт' : null }),
      noLab
    )
  )
  row(
    s,
    'Трафик',
    ...seg<LabTraffic>(
      [
        ['zero', 'Только что'],
        ['some', '205 МБ · 12 мин'],
        ['lots', '51 ГБ · 3 дня'],
        ['stale', 'Нет рукопожатий']
      ],
      (v) => traffic === v,
      (v) => {
        traffic = v
        lab()?.setTraffic(v)
      }
    )
  )
  const hint = el('p', { className: 'hint' })
  syncs.push(() => {
    const st = live.state
    const notes: string[] = []
    if (st?.needsCleanup && st.activeId) notes.push('«Сеть не восстановлена» видна только при выключенном VPN.')
    if (st?.degraded && !st.activeId) notes.push('«Связь потеряна» видна только при включённом VPN.')
    hint.textContent = notes.join(' ')
    hint.hidden = notes.length === 0
  })
  s.append(hint)
}

// ——— Как заканчиваются действия ———

{
  const s = section('Ответы на действия', 'Что вернёт «главный процесс» на следующее нажатие в приложении.', 'app')
  row(s, 'Подключиться', ...cfgSeg('connect', [['ok', 'Успешно'], ['error', 'Ошибка'], ['throw', 'Исключение'], ['cancel', 'Отмена пароля']]))
  row(s, 'Добавить ключ', ...cfgSeg('importLink', [['ok', 'Принят'], ['error', 'Отклонён']]))
  row(s, 'Скорость', ...cfgSeg('ping', [['fast', '38 мс'], ['slow', '412 мс'], ['none', 'Нет ответа']]))
  s.append(
    el(
      'p',
      { className: 'hint' },
      'Ключи для вставки: ',
      el('code', {}, 'vpn://lab'),
      ' и ',
      el('code', {}, 'sen://lab'),
      ' (',
      el('code', {}, 'sen://tls'),
      ' — с TLS, ',
      el('code', {}, 'sen://lab#ma7_0a1b2c'),
      ' — с логином MA7).'
    )
  )
}

// ——— Мастер-ключ ———

{
  const s = section('Мастер-ключ', 'Ключ показанного сервера, иначе первый. Нужен набор с мастер-ключом.', 'app')
  const noSub = (): boolean => current()?.sub === undefined
  row(
    s,
    'Статус',
    ...seg(
      [
        ['ok', 'Активен'],
        ['offline', 'Нет связи'],
        ['revoked', 'Отозван (401)']
      ] as const,
      (v) => current()?.sub?.status === v,
      (v) => lab()?.setSub({ status: v }),
      noSub
    )
  )
  row(
    s,
    '',
    check('Новые настройки ждут переподключения', () => Boolean(current()?.sub?.pendingRev), (on) => lab()?.setSub({ pendingRev: on }), noSub),
    check('Без TLS', () => Boolean(current()?.sub?.plain), (on) => lab()?.setSub({ plain: on }), noSub)
  )
  row(s, 'Устройства', ...cfgSeg('devices', [['ok', 'Отвечает'], ['slow', 'Долго'], ['error', 'Ошибка']]))
  row(
    s,
    'Занято',
    number(() => saved.cfg.deviceCount, (n) => ((saved.cfg.deviceCount = n), save()), 1, 6),
    el('span', { className: 'times' }, 'из'),
    number(() => saved.cfg.deviceLimit, (n) => ((saved.cfg.deviceLimit = n), save()), 1, 20)
  )
  row(s, 'Проверить снова', ...cfgSeg('refresh', [['ok', 'Активен'], ['offline', 'Нет связи'], ['revoked', 'Отозван']]))
  row(
    s,
    'Сценарий',
    button('Отвязать неожиданно', () => void lab()?.unbind(), undefined, () => noSub() || current()?.sub?.status === 'revoked')
  )
  s.append(
    el(
      'p',
      { className: 'hint' },
      'Устройство удалили в панели или удалили сам мастер-ключ: сервер отвечает 410. С включённым VPN пропадают рукопожатия, через пару секунд ' +
        'ключ уходит вместе с серверами (на Windows и Linux туннель сначала гасится ради запроса). Без VPN — при следующем опросе, ' +
        '«Проверить снова» или открытии «Ключа». Аккаунт MA7 остаётся: без других серверов главный экран предлагает новый ключ. ' +
        '«Отозван (401)» выше — ответ старого сервера или сбитые часы: ключ остаётся.'
    )
  )
}

// ——— Профиль MA7 ———

{
  const s = section('Профиль', 'Аккаунт MA7 из ссылки sen://…#ma7_…. Ответы применяются к следующему запросу: нажмите «Обновить» во вкладке.', 'app')
  const noSub = (): boolean => current()?.sub === undefined
  row(
    s,
    'Логин в ключе',
    text(() => current()?.sub?.login ?? '', (v) => lab()?.setSub({ login: v.trim() }), 'пусто — вкладки нет')
  )
  row(
    s,
    '',
    button('ma7_3f9a1c', () => lab()?.setSub({ login: 'ma7_3f9a1c' }), undefined, noSub),
    button('Убрать логин', () => lab()?.setSub({ login: '' }), undefined, noSub)
  )
  row(s, 'Ответ MA7', ...cfgSeg('profile', [['ok', 'Аккаунт'], ['slow', 'Долго'], ['notfound', 'Не найден'], ['error', 'Нет связи']]))
  row(
    s,
    'Статус',
    ...cfgSeg('profileStatus', [
      ['active', 'Активна'],
      ['processing', 'Проверка оплаты'],
      ['unpaid', 'Не оплачена'],
      ['overdue', 'Просрочена']
    ])
  )
  row(
    s,
    'До конца',
    number(() => saved.cfg.profileDays, (n) => ((saved.cfg.profileDays = n), save()), -60, 90),
    el('span', { className: 'hint' }, 'дней; меньше нуля — закончилась')
  )
  row(
    s,
    'Баланс, ₽',
    number(() => saved.cfg.balance, (n) => ((saved.cfg.balance = n), save()), 0, 100000),
    el('span', { className: 'times' }, 'в месяц'),
    number(() => saved.cfg.monthly, (n) => ((saved.cfg.monthly = n), save()), 0, 100000)
  )
  row(s, 'Устройств', number(() => saved.cfg.profileKeys, (n) => ((saved.cfg.profileKeys = n), save()), 0, 20))
  row(s, 'Реквизиты', ...cfgSeg('payment', [['ok', 'Есть'], ['slow', 'Долго'], ['error', 'Нет связи']]))
  row(s, 'Подтвердить', ...cfgSeg('paid', [['ok', 'Заявка принята'], ['approve', 'Админ подтвердит'], ['reject', 'Админ отклонит'], ['error', 'Ошибка']]))
  s.append(el('p', { className: 'hint' }, '«Оплатить» — только с токеном в логине. После «Подтвердить» окно и карточка ждут ответа админа: «Заявка принята» — он молчит (статус «Проверка оплаты» снимается здесь же), «подтвердит» и «отклонит» — отвечает через 6 с.'))
  row(s, 'Промокод', ...cfgSeg('promo', [['ok', 'Применён'], ['invalid', 'Не найден'], ['used', 'Уже был'], ['error', 'Нет связи']]))
}

// ——— Уведомления ———

{
  const s = section('Уведомления', 'Поверх главного экрана, кнопку подключения не сдвигают: одна строка сверху — самое важное и «+N», по нажатию панель со всеми. Подписка — важное, объявления и отвязка — обычные, подтверждения и новые устройства — второстепенные.', 'app')
  row(
    s,
    'Прислать',
    button('Подписка заканчивается', () => lab()?.pushNotice('ending'), undefined, noLab),
    button('Просрочена', () => lab()?.pushNotice('overdue'), undefined, noLab),
    button('Оплата подтверждена', () => lab()?.pushNotice('paid'), undefined, noLab),
    button('Оплата не подтверждена', () => lab()?.pushNotice('rejected'), undefined, noLab)
  )
  row(
    s,
    '',
    button('Техработы', () => lab()?.pushNotice('announce'), undefined, noLab),
    button('Новое устройство', () => lab()?.pushNotice('device'), undefined, noLab),
    button('Лимит уменьшен', () => lab()?.pushNotice('unbound'), undefined, noLab)
  )
  row(
    s,
    'Появилось на сервере',
    button('Техработы', () => lab()?.serverNotice('announce'), undefined, noLab),
    button('Подписка заканчивается', () => lab()?.serverNotice('ending'), undefined, noLab)
  )
  s.append(el('p', { className: 'hint' }, 'Приложение узнаёт о них само раз в пять минут или сразу — по кнопке «Обновить» в панели уведомлений (откройте панель нажатием на строку).'))
  row(s, '', button('Убрать все', () => lab()?.clearNotices(), undefined, noLab))
  s.append(el('p', { className: 'hint' }, '«Просрочена» без крестика: её убирает тот, кто прислал, когда оплата пройдёт («Убрать все»).'))
}

// ——— Обновление ———

{
  const s = section('Обновление', 'Карточка в «Настройки → Приложение».', 'app')
  const kind = (u: UpdateState | null): LabUpdate | null => {
    if (!u) return null
    switch (u.kind) {
      case 'idle':
        return u.checkedAt === null ? 'idle-never' : 'idle'
      case 'ready':
        return u.message ? 'ready-declined' : 'ready'
      case 'failed':
        return u.reason === 'unsupported' ? 'unsupported' : u.reason === 'revoked' ? 'failed-revoked' : u.installing ? 'failed-installing' : 'failed-network'
      default:
        return u.kind
    }
  }
  const states: [LabUpdate, string][] = [
    ['idle', 'Нет новее'],
    ['idle-never', 'Не проверялось'],
    ['checking', 'Проверка'],
    ['available', 'Доступно'],
    ['downloading', 'Загрузка'],
    ['ready', 'Готово'],
    ['ready-declined', 'Готово, отказ от пароля'],
    ['installing', 'Установка'],
    ['failed-network', 'Нет сети'],
    ['failed-installing', 'Не установилось'],
    ['failed-revoked', 'Версия отозвана'],
    ['unsupported', 'Не наша сборка']
  ]
  row(s, 'Состояние', ...seg(states, (v) => kind(live.update) === v, (v) => lab()?.setUpdate(v), noLab))
  row(s, 'Проверка найдёт', ...cfgSeg('updateCheck', [['newer', 'Новую версию'], ['latest', 'Ничего'], ['network', 'Нет сети']]))
  row(s, '', button('Показать «Обновлено до …»', () => lab()?.showUpdated(), undefined, noLab))
}

// ——— Система ———

{
  const s = section('Система', 'Читается при открытии вкладки «Приложение»: переключите вкладку, чтобы увидеть.', 'app')
  const flag = (key: 'optionsSupported' | 'canUninstall' | 'canRunInBackground', label: string): HTMLLabelElement =>
    check(label, () => saved.cfg[key], (on) => ((saved.cfg[key] = on), save()))
  row(s, 'Разрешено', flag('optionsSupported', 'Автозапуск'), flag('canUninstall', 'Удаление'), flag('canRunInBackground', 'Работа в фоне'))
  row(s, 'Автозапуск', ...cfgSeg('autoStart', [['ok', 'Включается'], ['refuse', 'Система отказала']]))
  row(s, 'Служба macOS', ...cfgSeg('macService', [['none', 'Нет'], ['current', 'Актуальна'], ['stale', 'Устарела'], ['silent', 'Молчит']]))
  row(s, 'Удалить службу', ...cfgSeg('macServiceRemove', [['done', 'Удалена'], ['cancelled', 'Отмена'], ['error', 'Ошибка']]))
  row(s, 'Удалить SenAWG', ...cfgSeg('uninstall', [['done', 'Удалено'], ['failed', 'Сбой на шаге 2'], ['cancelled', 'Отмена пароля']]))
}

// ——— Журнал ———

{
  const s = section('Журнал', 'Вкладка «Настройки → Диагностика».', 'app')
  row(
    s,
    'Добавить',
    button('+10 строк', () => lab()?.addLogs(10), undefined, noLab),
    button('+ предупреждение', () => lab()?.addLogs(1, 'warn'), undefined, noLab),
    button('+ ошибка', () => lab()?.addLogs(1, 'error'), undefined, noLab),
    button('+500', () => lab()?.addLogs(500), undefined, noLab)
  )
  row(
    s,
    '',
    check('Поток строк', () => streaming, (on) => {
      streaming = on
      lab()?.streamLogs(on)
    }, noLab)
  )
}

applyWindow()
open()
