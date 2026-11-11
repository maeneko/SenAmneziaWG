import { useContext, useRef, useState, useSyncExternalStore } from 'react'
import { RECHECK_MAX, RECHECK_MIN, RECHECK_PRESETS, isIpAddress, validRecheck, type ByteUnits, type InterfaceMode, type ThemeMode, type TrafficView, type UiSettings } from '@shared/uiSettings'
import { formatBytes } from '../lib/format'
import type { SettingsTab } from '../lib/settingsTab'
import type { PywalPalette } from '@shared/types'
import { isLinux, isMac } from '../lib/platform'
import { getWallpaper, importWallpaperFile, setWallpaper, subscribeWallpaper } from '../lib/wallpaper'
import { AppSettingsView } from './AppSettingsView'
import { Dialog } from './Dialog'
import { Button, Switch, UiModeContext } from './ui'

/** Sample session for the previews: 152.4 MB down, 23.1 MB up. */
const RX = 152_400_000
const TX = 23_100_000

interface Option<T> {
  value: T
  label: string
  preview?: (units: ByteUnits) => string
  /** The preview is a sample of data, not prose. */
  mono?: boolean
}

const TRAFFIC: Option<TrafficView>[] = [
  { value: 'total', label: 'Сколько потрачено всего', preview: (u) => `потрачено ${formatBytes(RX + TX, u)}`, mono: true },
  { value: 'split', label: 'Отдельно скачано и отправлено', preview: (u) => `↓ ${formatBytes(RX, u)}   ↑ ${formatBytes(TX, u)}`, mono: true },
  { value: 'hidden', label: 'Не показывать' }
]

const UNITS: Option<ByteUnits>[] = [
  { value: 'decimal', label: 'Мегабайты — МБ, по 1000', preview: () => (isMac ? 'как считает Finder' : 'как пишут на упаковке дисков') },
  { value: 'binary', label: 'Мебибайты — МиБ, по 1024', preview: () => 'как считают терминал и Linux' }
]

const UI_MODE: Option<InterfaceMode>[] = [
  { value: 'modern', label: 'Современный' },
  { value: 'legacy', label: 'Легаси' }
]

const THEME: Option<ThemeMode>[] = [
  { value: 'system', label: 'Как в системе', preview: () => 'светлая или тёмная — по настройке компьютера' },
  { value: 'light', label: 'Светлая' },
  { value: 'dark', label: 'Тёмная' }
]

/** «Фон под меню»: the veil's blur radius, in px. The values ride the setting as strings. */
const MENU_BLUR: Option<string>[] = [
  { value: '0', label: 'Выключено' },
  { value: '8', label: 'Лёгкое', preview: () => 'фон чуть заметно уходит назад' },
  { value: '18', label: 'Сильное', preview: () => 'фон почти растворяется' }
]

const RECHECK_LABELS: Record<number, string> = {
  30: 'Каждые 30 секунд',
  60: 'Раз в минуту',
  300: 'Раз в 5 минут',
  0: 'Только при подключении'
}
const RECHECK_ORDER = [30, 60, 300, 0]

/** Presets plus «Свой интервал»: a number of seconds, saved only while it is within bounds. */
function RecheckChoices({ value, onChange }: { value: number; onChange: (sec: number) => void }): React.JSX.Element {
  const preset = RECHECK_PRESETS.includes(value)
  const [own, setOwn] = useState(!preset)
  const [draft, setDraft] = useState(preset ? '' : String(value))
  const bad = own && draft.trim() !== '' && !validRecheck(Number(draft.trim())) || own && Number(draft) === 0
  const pick = (sec: number): void => {
    setOwn(false)
    onChange(sec)
  }
  return (
    <div className="choices">
      {RECHECK_ORDER.map((sec) => (
        <label key={sec} className="choice sl">
          <input type="radio" name="recheck" checked={!own && value === sec} onChange={() => pick(sec)} />
          <span className="choice-text">
            <span>{RECHECK_LABELS[sec]}</span>
          </span>
        </label>
      ))}
      <label className="choice sl">
        <input type="radio" name="recheck" checked={own} onChange={() => setOwn(true)} />
        <span className="choice-text">
          <span>Свой интервал</span>
          {own && (
            <span className="recheck-own">
              <input
                className="input mono"
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                aria-label="Интервал проверки, секунд"
                aria-invalid={bad || undefined}
                placeholder={`${RECHECK_MIN}–${RECHECK_MAX}`}
                value={draft}
                onChange={(e) => {
                  const text = e.target.value.replace(/\D/g, '')
                  setDraft(text)
                  const n = Number(text)
                  if (text !== '' && n !== 0 && validRecheck(n)) onChange(n)
                }}
              />
              <span className="hint">секунд, от {RECHECK_MIN} до {RECHECK_MAX}</span>
            </span>
          )}
        </span>
      </label>
    </div>
  )
}

const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i])

/**
 * The modern «Проверка соединения»: an M3 slider over the presets' stays — the left end keeps
 * «Только при подключении», the marks name 30 seconds, a minute and five minutes — and «Свой
 * интервал» waits as the last stop: landing there opens the seconds' field, as the radio's own
 * stop did. The thumb steps stop to stop (step=1), so the track needs no snapping of its own.
 */
function RecheckSlider({ value, onChange }: { value: number; onChange: (sec: number) => void }): React.JSX.Element {
  const preset = RECHECK_PRESETS.includes(value)
  const [own, setOwn] = useState(!preset)
  const [draft, setDraft] = useState(preset ? '' : String(value))
  const bad = (own && draft.trim() !== '' && !validRecheck(Number(draft.trim()))) || (own && Number(draft) === 0)
  /** The thumb's stay: the four presets keep their own places, «Свой интервал» holds the last. */
  const stop = own ? RECHECK_PRESETS.length : RECHECK_PRESETS.indexOf(value)
  const slide = (i: number): void => {
    if (i === RECHECK_PRESETS.length) {
      setOwn(true)
      return
    }
    setOwn(false)
    onChange(RECHECK_PRESETS[i])
  }
  /** The slider's value label: a preset's name on its stay, the own stop's name on the last. */
  const name = own ? 'Свой интервал' : RECHECK_LABELS[RECHECK_PRESETS[stop]]

  return (
    <div className="recheck-slider" style={{ '--q': stop } as React.CSSProperties}>
      <p className="recheck-current">{name}</p>
      <div className="recheck-rail">
        <input
          type="range"
          className="recheck-track"
          min={0}
          max={RECHECK_PRESETS.length}
          step={1}
          value={stop}
          aria-label="Интервал проверки соединения"
          aria-valuetext={name}
          onChange={(e) => slide(Number(e.target.value))}
        />
        {/* Dots on the middling stops (30s, 1m, 5m) behind the thumb's stay; the ends carry none,
            the M3 way — and the stay the thumb holds carries none either: its dot would only peek
            around the handle's own rounding. A dot lights on the walked side. */}
        <span className="recheck-marks" aria-hidden="true">
          {RECHECK_PRESETS.map((sec, i) =>
            i === 0 || i === stop ? null : (
              <i
                key={sec}
                className={i < stop ? 'on' : undefined}
                style={{ insetInlineStart: `calc(2px + (100% - 4px) * ${i} / 4)` }}
              />
            )
          )}
        </span>
      </div>
      {own && (
        <div className="recheck-own">
          <input
            className="input mono"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            aria-label="Интервал проверки, секунд"
            aria-invalid={bad || undefined}
            placeholder={`${RECHECK_MIN}–${RECHECK_MAX}`}
            value={draft}
            onChange={(e) => {
              const text = e.target.value.replace(/\D/g, '')
              setDraft(text)
              const n = Number(text)
              if (text !== '' && n !== 0 && validRecheck(n)) onChange(n)
            }}
          />
          <span className="hint">секунд, от {RECHECK_MIN} до {RECHECK_MAX}</span>
        </div>
      )}
    </div>
  )
}

/**
 * The wallpaper's continuous slider: the recheck drawing, a fraction instead of stops —
 * the rail's walked share rides --q (0…1), the handle and the track stay the M3 pair's.
 */
function WallSlider({ label, value, min, max, step, text, onChange }: {
  label: string
  value: number
  min: number
  max: number
  step: number
  text: (v: number) => string
  onChange: (v: number) => void
}): React.JSX.Element {
  const q = (value - min) / (max - min)
  return (
    <div className="wall-slider" style={{ '--q': q.toFixed(4) } as React.CSSProperties}>
      <p className="recheck-current">{label} — {text(value)}</p>
      <div className="recheck-rail">
        <input
          type="range"
          className="recheck-track"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={label}
          aria-valuetext={text(value)}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
    </div>
  )
}

/**
 * The wallpaper's own controls: pick or drop the picture, and while one is on — its blur,
 * its dim and the surfaces' opacity over it. The same pub-sub store the layer itself reads,
 * so every move here repaints the app live.
 */
function WallpaperChoices(): React.JSX.Element {
  const wall = useSyncExternalStore(subscribeWallpaper, getWallpaper)
  const input = useRef<HTMLInputElement>(null)
  const modern = useContext(UiModeContext) === 'modern'

  const pick = async (file: File | null | undefined): Promise<void> => {
    if (!file) return
    try {
      setWallpaper({ img: await importWallpaperFile(file) })
    } catch (e) {
      console.warn('wallpaper: import failed', e)
    }
  }

  return (
    <>
      <div className="wall-actions">
        <Button variant="tonal" icon="wallpaper" onClick={() => input.current?.click()}>
          Выбрать картинку
        </Button>
        {wall.img !== null && (
          <Button variant="text" onClick={() => setWallpaper({ img: null })}>
            Убрать
          </Button>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={() => {
          void pick(input.current?.files?.[0])
          if (input.current) input.current.value = ''
        }}
      />
      {wall.img !== null && modern && (
        <>
          <WallSlider label="Размытие" value={wall.blur} min={0} max={60} step={1}
            text={(v) => `${Math.round(v)} px`} onChange={(blur) => setWallpaper({ blur })} />
          <WallSlider label="Затемнение" value={wall.dim} min={0} max={1} step={0.05}
            text={(v) => `${Math.round(v * 100)} %`} onChange={(dim) => setWallpaper({ dim })} />
          <WallSlider label="Непрозрачность интерфейса" value={wall.fade} min={0.2} max={1} step={0.02}
            text={(v) => `${Math.round(v * 100)} %`} onChange={(fade) => setWallpaper({ fade })} />
        </>
      )}
    </>
  )
}

/**
 * Primary and secondary resolver, filled with the current key's DNS until the user types their own.
 * Saved only once every filled field is a valid IP; matching the key (or clearing both) saves
 * nothing, so every server keeps using the DNS from its own key.
 */
function DnsFields({ custom, keyDns, onSave }: {
  custom: string[]
  keyDns: string[]
  onSave: (servers: string[]) => void
}): React.JSX.Element {
  const initial = custom.length ? custom : keyDns
  const [draft, setDraft] = useState<[string, string]>([initial[0] ?? '', initial[1] ?? ''])
  const invalid = draft.map((v) => v.trim() !== '' && !isIpAddress(v.trim()))
  const filled = draft.map((v) => v.trim()).filter(Boolean)
  const own = filled.length > 0 && !sameList(filled, keyDns.slice(0, 2))

  const save = (next: [string, string]): void => {
    setDraft(next)
    const values = next.map((v) => v.trim()).filter(Boolean)
    if (!values.every(isIpAddress)) return
    onSave(values.length && !sameList(values, keyDns.slice(0, 2)) ? values : [])
  }

  const reset = (): void => save([keyDns[0] ?? '', keyDns[1] ?? ''])

  const fields = [
    { id: 'dns-primary', label: 'Основной', placeholder: '1.1.1.1' },
    { id: 'dns-secondary', label: 'Дополнительный', placeholder: 'необязательно' }
  ] as const

  return (
    <div className="dns-fields">
      {fields.map((f, i) => (
        <label key={f.id} className="field" htmlFor={f.id}>
          <span className="field-label">{f.label}</span>
          <input
            id={f.id}
            className="input mono"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            placeholder={f.placeholder}
            value={draft[i]}
            aria-invalid={invalid[i] || undefined}
            aria-describedby={invalid[i] ? `${f.id}-error` : undefined}
            onChange={(e) => save(i === 0 ? [e.target.value, draft[1]] : [draft[0], e.target.value])}
          />
          {invalid[i] && (
            <span id={`${f.id}-error`} className="form-error">
              Не похоже на IP-адрес
            </span>
          )}
        </label>
      ))}
      {own && keyDns.length > 0 && (
        <Button className="dns-reset" variant="tonal" onClick={reset}>
          Вернуть из ключа
        </Button>
      )}
    </div>
  )
}

function Choices<T extends string>({ name, options, value, units, onChange }: {
  name: string
  options: Option<T>[]
  value: T
  units: ByteUnits
  onChange: (value: T) => void
}): React.JSX.Element {
  return (
    <div className="choices">
      {options.map((o) => (
        <label key={o.value} className="choice sl">
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
          <span className="choice-text">
            <span>{o.label}</span>
            {o.preview && <span className={`hint${o.mono ? ' choice-sample' : ''}`}>{o.preview(units)}</span>}
          </span>
        </label>
      ))}
    </div>
  )
}

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'app', label: 'Приложение' },
  { id: 'interface', label: 'Интерфейс' },
  { id: 'network', label: 'Сеть' },
  { id: 'diagnostics', label: 'Диагностика' }
]

const EXPERIMENTAL: { id: SettingsTab; label: string } = { id: 'experimental', label: 'Экспериментальные' }

/** «Экспериментальные» exists after the logo was tapped five times on Настройки (see App), on any platform;
    leaving Настройки hides it again. */
const tabsFor = (experimental: boolean): typeof TABS => (experimental ? [...TABS, EXPERIMENTAL] : TABS)

// A tab stored on one platform and opened on another: fall back rather than show an empty panel.
const shown = (tab: SettingsTab, experimental: boolean): SettingsTab => (tabsFor(experimental).some((t) => t.id === tab) ? tab : 'app')

/**
 * The tab bar. App puts it above the scrolling part of the page, next to the header, so that — like the
 * header — it stays in place while a long tab scrolls under it.
 */
export function SettingsTabs({ tab, experimental, onTab }: {
  tab: SettingsTab
  experimental: boolean
  onTab: (tab: SettingsTab) => void
}): React.JSX.Element {
  const TABS = tabsFor(experimental)
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const active = shown(tab, experimental)

  // WAI-ARIA tabs: arrows move between tabs (and select them), only the active one is in the Tab order.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const at = TABS.findIndex((t) => t.id === active)
    const next = (at + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length
    onTab(TABS[next].id)
    tabs.current[next]?.focus()
  }

  return (
    <div className="seg settings-tabs" role="tablist" aria-label="Разделы настроек" onKeyDown={onKeyDown}>
      {TABS.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            tabs.current[i] = el
          }}
          type="button"
          role="tab"
          id={`settings-tab-${t.id}`}
          aria-selected={active === t.id}
          aria-controls={`settings-panel-${t.id}`}
          tabIndex={active === t.id ? 0 : -1}
          className={`seg-btn sl${active === t.id ? ' seg-btn-active' : ''}`}
          onClick={() => onTab(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

/** The open tab's panel; its tab bar is SettingsTabs. */
export function SettingsView({ tab, experimental, pywal, logs, settings, keyDns, diagnostics, onChange, onDiagnostics, uninstallError, onUninstall }: {
  /** Owned by App: the Диагностика tab needs the page to stop scrolling and give the journal the full height. */
  tab: SettingsTab
  experimental: boolean
  /** The palette in use while «Цвета pywal» is on; null when it is off or pywal has written none. */
  pywal: PywalPalette | null
  /** The journal itself; it fills whatever height the tab has left. */
  logs: React.ReactNode
  settings: UiSettings
  /** DNS written in the current server's key: what the fields start with. */
  keyDns: string[]
  diagnostics: boolean
  onChange: (patch: Partial<UiSettings>) => void
  onDiagnostics: (enabled: boolean) => void
  uninstallError: string | null
  onUninstall: (keepData: boolean) => void
}): React.JSX.Element {
  const active = shown(tab, experimental)
  const [confirmPywal, setConfirmPywal] = useState(false)
  const modern = useContext(UiModeContext) === 'modern'

  return (
    <>
      <div
        id={`settings-panel-${active}`}
        role="tabpanel"
        aria-labelledby={`settings-tab-${active}`}
        className={`settings-panel${active === 'diagnostics' ? ' settings-panel-fill' : ''}`}
      >
        {active === 'interface' && (
          <>
            <section className="settings-group" aria-labelledby="set-uimode">
              <h2 id="set-uimode" className="settings-title">Режим интерфейса</h2>
              <p className="hint">Нижняя панель и иконки. «Легаси» — как выглядело в 0.9.0.</p>
              <Choices
                name="interface-mode"
                options={UI_MODE}
                value={settings.interfaceMode}
                units={settings.units}
                onChange={(interfaceMode) => onChange({ interfaceMode })}
              />
            </section>

            <section className="settings-group" aria-labelledby="set-theme">
              <h2 id="set-theme" className="settings-title">Тема</h2>
              <Choices name="theme" options={THEME} value={settings.theme} units={settings.units} onChange={(theme) => onChange({ theme })} />
            </section>

            <section className="settings-group" aria-labelledby="set-wallpaper">
              <h2 id="set-wallpaper" className="settings-title">Обои</h2>
              <p className="hint">Картинка за интерфейсом. В окно её можно принести и перетаскиванием, и Ctrl+V.</p>
              <WallpaperChoices />
            </section>

            <section className="settings-group" aria-labelledby="set-menublur">
              <h2 id="set-menublur" className="settings-title">Фон под меню</h2>
              <p className="hint">Когда открыто меню, лист или диалог, фон за ним слегка размывается. «Главная» при этом остаётся чистой.</p>
              <Choices
                name="menu-blur"
                options={MENU_BLUR}
                value={String(settings.menuBlur)}
                units={settings.units}
                onChange={(v) => onChange({ menuBlur: Number(v) })}
              />
            </section>

            <section className="settings-group" aria-labelledby="set-traffic">
              <h2 id="set-traffic" className="settings-title">Расход интернета</h2>
              <p className="hint">Под кнопкой подключения, считается с момента подключения.</p>
              <Choices name="traffic" options={TRAFFIC} value={settings.traffic} units={settings.units} onChange={(traffic) => onChange({ traffic })} />
            </section>

            <section className="settings-group" aria-labelledby="set-units">
              <h2 id="set-units" className="settings-title">Единицы</h2>
              <Choices name="units" options={UNITS} value={settings.units} units={settings.units} onChange={(units) => onChange({ units })} />
            </section>
          </>
        )}

        {active === 'network' && (
          <>
            <section className="settings-group" aria-labelledby="set-recheck">
              <h2 id="set-recheck" className="settings-title">Проверка соединения</h2>
              <p className="hint">Как часто, пока VPN включён, проверять, что через туннель проходит трафик. Если проверка не удалась два раза подряд, на главном экране появится предупреждение.</p>
              {modern ? (
                <RecheckSlider value={settings.recheckSec} onChange={(recheckSec) => onChange({ recheckSec })} />
              ) : (
                <RecheckChoices value={settings.recheckSec} onChange={(recheckSec) => onChange({ recheckSec })} />
              )}
            </section>

            <section className="settings-group" aria-labelledby="set-dns">
              <h2 id="set-dns" className="settings-title">DNS</h2>
              <p className="hint">Какие серверы система спрашивает об адресах сайтов, пока VPN включён. Действует со следующего подключения.</p>
              <DnsFields key={keyDns.join(',')} custom={settings.dnsCustom} keyDns={keyDns} onSave={(dnsCustom) => onChange({ dnsCustom })} />
            </section>

          </>
        )}

        {active === 'app' && (
          <AppSettingsView settings={settings} onChange={onChange} uninstallError={uninstallError} onUninstall={onUninstall} />
        )}

        {active === 'experimental' && (
          <section className="settings-group" aria-labelledby="set-experimental">
            <h2 id="set-experimental" className="settings-title">Debug</h2>
            <p className="hint">То, что ещё проверяется и может работать нестабильно. Раздел виден, пока вы не выйдете из настроек.</p>
            {isMac && (
              <label className="choice sl">
                <Switch checked={diagnostics} onChange={onDiagnostics} />
                <span className="choice-text">
                  <span>Захват пакетов</span>
                  <span className="hint">
                    При следующем подключении 25 с записывать заголовки пакетов и снимок сетевых настроек — чтобы найти,
                    где теряется трафик. Итог появится ниже, в журнале.
                  </span>
                </span>
              </label>
            )}
            {isLinux && (
              <label className="choice sl">
                <Switch checked={settings.linuxTray} onChange={(linuxTray) => onChange({ linuxTray })} />
                <span className="choice-text">
                  <span>Значок в трее (waybar)</span>
                  <span className="hint">
                    Закрытое окно прячется в значок, и подключение не обрывается; выйти совсем — через его меню. Нужен
                    трей-хост: модуль tray в waybar или панель с поддержкой StatusNotifierItem. Без него окно, закрытое
                    крестиком, не вернуть, кроме как повторным запуском senawg.
                  </span>
                </span>
              </label>
            )}
            {isLinux && (
              <label className="choice sl">
                <Switch checked={settings.pywal} onChange={(on) => (on ? setConfirmPywal(true) : onChange({ pywal: false }))} />
                <span className="choice-text">
                  <span>Цвета pywal</span>
                  <span className="hint">
                    Красить интерфейс палитрой из ~/.cache/wal/colors.json и подхватывать новую при смене обоев.
                  </span>
                  {settings.pywal && !pywal && (
                    <span className="hint">Палитра не найдена: запустите wal -i с обоями, и цвета появятся сами.</span>
                  )}
                </span>
              </label>
            )}
          </section>
        )}

        {active === 'diagnostics' && <>{logs}</>}

      </div>
      {confirmPywal && (
        <Dialog
          title="Включить цвета pywal?"
          onClose={() => setConfirmPywal(false)}
          actions={
            <>
              <Button variant="tonal" onClick={() => setConfirmPywal(false)}>
                Отмена
              </Button>
              <Button
                onClick={() => {
                  setConfirmPywal(false)
                  onChange({ pywal: true })
                }}
              >
                Включить
              </Button>
            </>
          }
        >
          <p>
            Цвета берутся из палитры обоев как есть, и на некоторых палитрах интерфейс может стать плохо читаемым или
            выглядеть сломанным: слабый контраст, слившийся текст. Выключить это можно здесь же.
          </p>
        </Dialog>
      )}
    </>
  )
}
