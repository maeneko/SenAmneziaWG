import { useRef, useState } from 'react'
import { RECHECK_MAX, RECHECK_MIN, RECHECK_PRESETS, isIpAddress, validRecheck, type ByteUnits, type ThemeMode, type TrafficView, type UiSettings } from '@shared/uiSettings'
import { formatBytes } from '../lib/format'
import type { SettingsTab } from '../lib/settingsTab'
import type { PywalPalette } from '@shared/types'
import { isMac } from '../lib/platform'
import { AppSettingsView } from './AppSettingsView'
import { Dialog } from './Dialog'
import { Button, Switch } from './ui'

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

const THEME: Option<ThemeMode>[] = [
  { value: 'system', label: 'Как в системе', preview: () => 'светлая или тёмная — по настройке компьютера' },
  { value: 'light', label: 'Светлая' },
  { value: 'dark', label: 'Тёмная' }
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

/** «Экспериментальные» exists on Linux only, and only after the logo was tapped five times (see App); leaving Настройки hides it again. */
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
            <section className="settings-group" aria-labelledby="set-theme">
              <h2 id="set-theme" className="settings-title">Тема</h2>
              <Choices name="theme" options={THEME} value={settings.theme} units={settings.units} onChange={(theme) => onChange({ theme })} />
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
              <RecheckChoices value={settings.recheckSec} onChange={(recheckSec) => onChange({ recheckSec })} />
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
            <h2 id="set-experimental" className="settings-title">Экспериментальные настройки</h2>
            <p className="hint">То, что ещё проверяется и может работать нестабильно. Раздел виден, пока вы не выйдете из настроек.</p>
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
          </section>
        )}

        {active === 'diagnostics' && (
          <>
            {/* Packet capture exists only in the macOS backend. */}
            {isMac && (
              <section className="settings-group" aria-labelledby="set-capture">
                <h2 id="set-capture" className="settings-title">Захват пакетов</h2>
                <label className="choice sl">
                  <Switch checked={diagnostics} onChange={onDiagnostics} />
                  <span className="choice-text">
                    <span>Записывать при подключении</span>
                    <span className="hint">
                      При следующем подключении 25 с записывать заголовки пакетов и снимок сетевых настроек — чтобы найти,
                      где теряется трафик. Итог появится ниже, в журнале.
                    </span>
                  </span>
                </label>
              </section>
            )}
            {logs}
          </>
        )}

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
