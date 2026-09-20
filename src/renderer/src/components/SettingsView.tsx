import { useRef, useState } from 'react'
import { isIpAddress, type ByteUnits, type TrafficView, type UiSettings } from '@shared/uiSettings'
import { formatBytes } from '../lib/format'
import type { SettingsTab } from '../lib/settingsTab'
import { isMac } from '../lib/platform'
import { AboutView } from './AboutView'
import { AppSettingsView } from './AppSettingsView'
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
  { id: 'interface', label: 'Интерфейс' },
  { id: 'network', label: 'Сеть' },
  { id: 'app', label: 'Приложение' },
  { id: 'diagnostics', label: 'Диагностика' },
  { id: 'about', label: 'Об AmnesiaWG' }
]

export function SettingsView({ tab, onTab, logs, settings, keyDns, diagnostics, onChange, onDiagnostics }: {
  /** Owned by App: the Диагностика tab needs the page to stop scrolling and give the journal the full height. */
  tab: SettingsTab
  onTab: (tab: SettingsTab) => void
  /** The journal itself; it fills whatever height the tab has left. */
  logs: React.ReactNode
  settings: UiSettings
  /** DNS written in the current server's key: what the fields start with. */
  keyDns: string[]
  diagnostics: boolean
  onChange: (patch: Partial<UiSettings>) => void
  onDiagnostics: (enabled: boolean) => void
}): React.JSX.Element {
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const select = onTab
  // A tab stored on one platform and opened on another: fall back rather than show an empty panel.
  const active = TABS.some((t) => t.id === tab) ? tab : 'interface'

  // WAI-ARIA tabs: arrows move between tabs (and select them), only the active one is in the Tab order.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const at = TABS.findIndex((t) => t.id === active)
    const next = (at + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length
    select(TABS[next].id)
    tabs.current[next]?.focus()
  }

  return (
    <>
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
            onClick={() => select(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div
        id={`settings-panel-${active}`}
        role="tabpanel"
        aria-labelledby={`settings-tab-${active}`}
        className={`settings-panel${active === 'diagnostics' ? ' settings-panel-fill' : ''}`}
      >
        {active === 'interface' && (
          <>
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
            <section className="settings-group" aria-labelledby="set-dns">
              <h2 id="set-dns" className="settings-title">DNS</h2>
              <p className="hint">Какие серверы система спрашивает об адресах сайтов, пока VPN включён. Действует со следующего подключения.</p>
              <DnsFields key={keyDns.join(',')} custom={settings.dnsCustom} keyDns={keyDns} onSave={(dnsCustom) => onChange({ dnsCustom })} />
            </section>
          </>
        )}

        {active === 'app' && <AppSettingsView settings={settings} onChange={onChange} />}

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

        {active === 'about' && <AboutView />}
      </div>
    </>
  )
}
