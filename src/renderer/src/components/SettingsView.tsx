import { useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { RECHECK_MAX, RECHECK_MIN, RECHECK_PRESETS, THEMES, isDohUrl, isIpAddress, validRecheck, type ByteUnits, type DohMode, type InterfaceMode, type ThemeMode, type TrafficView, type UiSettings } from '@shared/uiSettings'
import { formatBytes } from '../lib/format'
import type { SettingsTab } from '../lib/settingsTab'
import type { PywalPalette } from '@shared/types'
import { isLinux, isMac } from '../lib/platform'
import { getWallpaper, importWallpaperFile, setWallpaper, subscribeWallpaper, WALLPAPER_BASE_ZOOM, WALLPAPER_MAX_SCALE, type DimTone } from '../lib/wallpaper'
import { AppSettingsView } from './AppSettingsView'
import { Dialog } from './Dialog'
import { Button, Icon, IconButton, Switch, UiModeContext } from './ui'

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
/** The icon-button row for «Единицы»: the button's own text and the caption under the title. */
const UNITS_BTN: Record<ByteUnits, { text: string; note: string }> = {
  decimal: { text: 'МБ', note: 'МБ, по 1000' },
  binary: { text: 'МиБ', note: 'МиБ, по 1024' }
}

const UI_MODE: Option<InterfaceMode>[] = [
  { value: 'modern', label: 'Современный' },
  { value: 'legacy', label: 'Легаси' }
]

/** «DoH»: who answers the app's question «где адрес сервера» before a connection is made. */
const DOH: Option<DohMode>[] = [
  { value: 'off', label: 'Как обычно', preview: () => 'через DNS провайдера' },
  { value: 'cloudflare', label: 'DoH, Cloudflare', preview: () => 'через 1.1.1.1 по HTTPS' },
  { value: 'custom', label: 'Своя ссылка' }
]

/** The endpoint of the «Своя ссылка» choice: saved as soon as it parses, an error while it does not. */
function DohUrlField({ url, onSave }: { url: string; onSave: (url: string) => void }): React.JSX.Element {
  const [draft, setDraft] = useState(url)
  const invalid = draft.trim() !== '' && !isDohUrl(draft.trim())
  return (
    <label className="field" htmlFor="doh-url">
      <span className="field-label">Адрес резолвера</span>
      <input
        id="doh-url"
        className="input mono"
        type="url"
        autoComplete="off"
        spellCheck={false}
        placeholder="https://example.com/dns-query"
        value={draft}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? 'doh-url-error' : undefined}
        onChange={(e) => {
          setDraft(e.target.value)
          const value = e.target.value.trim()
          if (isDohUrl(value)) onSave(value)
        }}
      />
      {invalid && (
        <span id="doh-url-error" className="form-error">
          Нужен адрес вида https://…/dns-query
        </span>
      )}
    </label>
  )
}

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
        {/* The M3 expressive value indicator: the number floats over the handle while it is held
            or focused, so the row's own line can step aside and let the bubble read. The tail is
            its own mark: the bubble may clamp at the ends, the tail still points at the handle. */}
        <span className="recheck-value" aria-hidden="true">{text(value)}</span>
        <span className="recheck-tail" aria-hidden="true" />
      </div>
    </div>
  )
}

/**
 * The wallpaper's own controls: pick or drop the picture, and while one is on — its blur,
 * its dim (with the scrim's tone), the surfaces' opacity over it, the framing of the picture
 * and the offline drain. The same pub-sub store the layer itself reads, so every move here
 * repaints the app live.
 */
function WallpaperChoices(): React.JSX.Element {
  const wall = useSyncExternalStore(subscribeWallpaper, getWallpaper)
  const input = useRef<HTMLInputElement>(null)
  const modern = useContext(UiModeContext) === 'modern'
  // The framing editor: local while the dialog is open, saved in one move by «Готово».
  const [place, setPlace] = useState<WallPlacement | null>(null)
  const [aspect, setAspect] = useState(1.6)
  const frame = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; ox: number; oy: number; sx: number; sy: number } | null>(null)

  const pick = async (file: File | null | undefined): Promise<void> => {
    if (!file) return
    try {
      // A fresh picture lands on its own look: centred, plainly scaled.
      setWallpaper({ img: await importWallpaperFile(file), scale: 1, offsetX: 0, offsetY: 0 })
    } catch (e) {
      console.warn('wallpaper: import failed', e)
    }
  }

  const remove = (): void => setWallpaper({ img: null, scale: 1, offsetX: 0, offsetY: 0 })

  const openPlace = (): void => {
    // The preview takes the window's own shape — the picture behind the app is cropped by the
    // whole stage, so a phone-shaped window gets a phone-shaped frame.
    setAspect(Math.min(2.6, Math.max(0.45, window.innerWidth / window.innerHeight)))
    setPlace({ scale: wall.scale, offsetX: wall.offsetX, offsetY: wall.offsetY })
  }

  const savePlace = (): void => {
    if (!place) return
    setWallpaper({ scale: place.scale, offsetX: place.offsetX, offsetY: place.offsetY })
    setPlace(null)
  }

  // The wheel is the pinch: zoom the framing inside the dialog, under the pointer.
  const opened = place !== null
  useEffect(() => {
    const el = frame.current
    if (!opened || !el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      setPlace((prev) => prev && {
        ...prev,
        scale: Math.min(WALLPAPER_MAX_SCALE, Math.max(1, prev.scale - e.deltaY * 0.0015))
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [opened])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!place || e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.focus()
    const zoom = WALLPAPER_BASE_ZOOM * place.scale
    const w = e.currentTarget.clientWidth
    const h = e.currentTarget.clientHeight
    drag.current = {
      x: e.clientX,
      y: e.clientY,
      ox: place.offsetX,
      oy: place.offsetY,
      // The pan's reach in pixels: half the picture's overflow on each axis.
      sx: Math.max(1, (w * (zoom - 1)) / 2),
      sy: Math.max(1, (h * (zoom - 1)) / 2)
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    setPlace((prev) => prev && {
      ...prev,
      offsetX: Math.min(1, Math.max(-1, d.ox + (e.clientX - d.x) / d.sx)),
      offsetY: Math.min(1, Math.max(-1, d.oy + (e.clientY - d.y) / d.sy))
    })
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    drag.current = null
  }

  const nudge = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!place) return
    const step = e.shiftKey ? 0.12 : 0.04
    const patch: Partial<WallPlacement> = {}
    if (e.key === 'ArrowLeft') patch.offsetX = Math.max(-1, place.offsetX - step)
    else if (e.key === 'ArrowRight') patch.offsetX = Math.min(1, place.offsetX + step)
    else if (e.key === 'ArrowUp') patch.offsetY = Math.min(1, place.offsetY + step)
    else if (e.key === 'ArrowDown') patch.offsetY = Math.max(-1, place.offsetY - step)
    else if (e.key === '+' || e.key === '=') patch.scale = Math.min(WALLPAPER_MAX_SCALE, place.scale + 0.08)
    else if (e.key === '-' || e.key === '_') patch.scale = Math.max(1, place.scale - 0.08)
    else return
    e.preventDefault()
    setPlace({ ...place, ...patch })
  }

  const tones: Array<{ value: DimTone; label: string }> = [
    { value: 'auto', label: 'Как в теме' },
    { value: 'light', label: 'Светлый' },
    { value: 'dark', label: 'Тёмный' }
  ]
  const previewZoom = place ? WALLPAPER_BASE_ZOOM * place.scale : WALLPAPER_BASE_ZOOM
  const previewSlack = (previewZoom - 1) * 50

  return (
    <>
      {/* The card's head, as one row: the name with its caption on the left, the pick button standing alone on
         the right — a square icon button, not a pill of text. */}
      <div className="wall-head">
        <div>
          <h2 id="set-wallpaper" className="settings-title">Обои</h2>
          <p className="hint">Картинка за интерфейсом</p>
        </div>
        <div className="wall-actions">
          {wall.img !== null && <IconButton icon="close" label="Убрать обои" onClick={remove} />}
          <IconButton icon="wallpaper" label="Выбрать картинку" onClick={() => input.current?.click()} />
        </div>
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
          {/* The dim tone: the scrim may follow the theme or pin its own side. */}
          <div className="wall-head wall-tone">
            <div>
              <h2 id="set-dim-tone" className="settings-title">Цвет затемнения</h2>
              <p className="hint">Оттенок затемнения обоев</p>
            </div>
            <div className="wall-actions theme-actions" role="radiogroup" aria-labelledby="set-dim-tone">
              {tones.map((t) => {
                const on = wall.tone === t.value
                return (
                  <button
                    key={t.value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    title={t.label}
                    aria-label={t.label}
                    className={`icon-btn sl theme-btn${on ? ' theme-btn-on' : ''}`}
                    onClick={() => setWallpaper({ tone: t.value })}
                  >
                    <Icon name={t.value === 'auto' ? 'themeAuto' : t.value === 'light' ? 'themeLight' : 'themeDark'} />
                  </button>
                )
              })}
            </div>
          </div>
          <WallSlider label="Непрозрачность интерфейса" value={wall.fade} min={0.2} max={1} step={0.02}
            text={(v) => `${Math.round(v * 100)} %`} onChange={(fade) => setWallpaper({ fade })} />
          {/* Framing: a dialog with the picture as the drag handle, as the long-press preview. */}
          <div className="wall-head wall-place">
            <div>
              <h2 id="set-place" className="settings-title">Положение и масштаб</h2>
              <p className="hint">
                {wall.scale > 1.001 || wall.offsetX !== 0 || wall.offsetY !== 0
                  ? `Масштаб ×${wall.scale.toFixed(2)}`
                  : 'Как обрезана картинка'}
              </p>
            </div>
            <div className="wall-actions">
              <IconButton icon="move" label="Настроить положение обоев" onClick={openPlace} />
            </div>
          </div>
          {/* The tunnel link is the app's own: the picture alone drains while it is not up. */}
          <div className="wall-head wall-gray">
            <div>
              <h2 id="set-grayscale" className="settings-title">Чёрно-белые при отключении</h2>
              <p className="hint">Пока туннель отключён, обои становятся монохромными</p>
            </div>
            <div className="wall-actions">
              <Switch
                checked={wall.grayOffline}
                onChange={(grayOffline) => setWallpaper({ grayOffline })}
                aria-labelledby="set-grayscale"
              />
            </div>
          </div>
        </>
      )}
      {place && wall.img !== null && (
        <Dialog
          title="Положение обоев"
          onClose={() => setPlace(null)}
          animateClose
          actions={
            <>
              <Button variant="tonal" onClick={() => setPlace({ ...place, scale: 1, offsetX: 0, offsetY: 0 })}>
                Сбросить
              </Button>
              <Button variant="tonal" onClick={() => setPlace(null)}>Отмена</Button>
              <Button onClick={savePlace}>Готово</Button>
            </>
          }
        >
          <div
            ref={frame}
            className="wall-move-frame"
            style={{ '--wall-aspect': aspect.toFixed(3) } as React.CSSProperties}
            tabIndex={0}
            role="group"
            aria-label="Кадр обоев: перетаскивайте картинку, стрелки двигают, плюс и минус меняют масштаб"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={nudge}
          >
            <div
              className="wall-move-img"
              style={{
                backgroundImage: `url("${wall.img}")`,
                transform: `translate(${(place.offsetX * previewSlack).toFixed(3)}%, ${(place.offsetY * previewSlack).toFixed(3)}%) scale(${previewZoom.toFixed(4)})`
              }}
            />
          </div>
          <p className="hint wall-move-hint">Перетащите картинку, чтобы выбрать кадр.</p>
          <WallSlider label="Масштаб" value={place.scale} min={1} max={WALLPAPER_MAX_SCALE} step={0.05}
            text={(v) => `×${v.toFixed(2)}`} onChange={(scale) => setPlace({ ...place, scale })} />
          <WallSlider label="Сдвиг по горизонтали" value={place.offsetX} min={-1} max={1} step={0.02}
            text={(v) => `${Math.round(v * 100)} %`} onChange={(offsetX) => setPlace({ ...place, offsetX })} />
          <WallSlider label="Сдвиг по вертикали" value={place.offsetY} min={-1} max={1} step={0.02}
            text={(v) => `${Math.round(v * 100)} %`} onChange={(offsetY) => setPlace({ ...place, offsetY })} />
        </Dialog>
      )}
    </>
  )
}

/** The framing under edit in the position dialog: local until «Готово» writes it to the store. */
interface WallPlacement {
  scale: number
  offsetX: number
  offsetY: number
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

/** The one DNS card: its own two tabs — the system's servers, and how the app resolves the server. */
function DnsCard({ settings, keyDns, onChange }: {
  settings: UiSettings
  keyDns: string[]
  onChange: (patch: Partial<UiSettings>) => void
}): React.JSX.Element {
  const [pane, setPane] = useState<'dns' | 'doh'>('dns')
  return (
    <section className="settings-group" aria-labelledby="set-dns">
      <h2 id="set-dns" className="settings-title">DNS</h2>
      <div className="seg dns-seg" role="tablist" aria-label="Разделы DNS">
        <button
          type="button"
          role="tab"
          aria-selected={pane === 'dns'}
          aria-controls="dns-pane"
          className={`seg-btn sl${pane === 'dns' ? ' seg-btn-active' : ''}`}
          onClick={() => setPane('dns')}
        >
          DNS
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={pane === 'doh'}
          aria-controls="doh-pane"
          className={`seg-btn sl${pane === 'doh' ? ' seg-btn-active' : ''}`}
          onClick={() => setPane('doh')}
        >
          DoH
        </button>
      </div>
      {pane === 'dns' ? (
        <div id="dns-pane" role="tabpanel">
          <DnsFields key={keyDns.join(',')} custom={settings.dnsCustom} keyDns={keyDns} onSave={(dnsCustom) => onChange(dnsCustom.length ? { dnsCustom, doh: 'off' } : { dnsCustom })} />
        </div>
      ) : (
        <div id="doh-pane" role="tabpanel">
          <Choices name="doh" options={DOH} value={settings.doh} units={settings.units} onChange={(doh) => onChange(doh !== 'off' ? { doh, dnsCustom: [] } : { doh })} />
          {settings.doh === 'custom' && <DohUrlField url={settings.dohUrl} onSave={(dohUrl) => onChange({ dohUrl })} />}
        </div>
      )}
    </section>
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
  const [noticeTest, setNoticeTest] = useState<'sent' | 'unsupported' | null>(null)
  const modern = useContext(UiModeContext) === 'modern'

  const testNotification = (): void => {
    setNoticeTest(null)
    void window.awg.testNotification().then(
      (ok) => setNoticeTest(ok ? 'sent' : 'unsupported'),
      () => setNoticeTest('unsupported')
    )
  }

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
              <Choices
                name="interface-mode"
                options={UI_MODE}
                value={settings.interfaceMode}
                units={settings.units}
                onChange={(interfaceMode) => onChange({ interfaceMode })}
              />
            </section>

            <section className={`settings-group${modern ? ' wall-group' : ''}`} aria-labelledby="set-theme">
            {modern ? (
              /* The theme as a row of square icon buttons, as «Обои»' pick: system, light, dark. */
              <div className="wall-head">
                <div>
                  <h2 id="set-theme" className="settings-title">Тема</h2>
                </div>
                <div className="wall-actions theme-actions" role="radiogroup" aria-labelledby="set-theme">
                  {THEMES.map((t) => {
                    const on = settings.theme === t
                    const label = THEME.find((o) => o.value === t)?.label ?? t
                    return (
                      <button
                        key={t}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        title={label}
                        aria-label={label}
                        className={`icon-btn sl theme-btn${on ? ' theme-btn-on' : ''}`}
                        onClick={() => onChange({ theme: t })}
                      >
                        <Icon name={t === 'system' ? 'themeAuto' : t === 'light' ? 'themeLight' : 'themeDark'} />
                      </button>
                    )
                  })}
                </div>
              </div>
            ) : (
              <>
                <h2 id="set-theme" className="settings-title">Тема</h2>
                <Choices name="theme" options={THEME} value={settings.theme} units={settings.units} onChange={(theme) => onChange({ theme })} />
              </>
            )}
            </section>

            {/* «Обои» and «Размытие навигации» share one card — two rows over one ground, as «Расход
                интернета» and «Единицы» do: flat 2px seams, square inner corners, the card's radius outside. */}
            <section className="settings-group wall-stack" aria-labelledby="set-wallpaper">
              <div>
                <WallpaperChoices />
              </div>
              {/* «Размытие навигации»: the toggle on the card's head kills the frost (the glass keeps
                  its tone), the slider speaks in percents (30 px = 100%) and stays remembered while off.
                  The row rides higher (navblur-row): a centred pair inside a 44px head otherwise pushes
                  the title to 30px off the seam, where every other title sits at 18–21px. */}
              <div className="navblur-row">
                <div className="wall-head">
                  <div>
                    <h2 id="set-navblur" className="settings-title">Размытие навигации</h2>
                  </div>
                  <div className="wall-actions">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={settings.navBlurOn}
                      title={settings.navBlurOn ? 'Размытие включено' : 'Размытие выключено'}
                      aria-label="Размытие навигации"
                      className={`icon-btn sl theme-btn${settings.navBlurOn ? ' theme-btn-on' : ''}`}
                      onClick={() => onChange({ navBlurOn: !settings.navBlurOn })}
                    >
                      <Icon name="blurOn" />
                    </button>
                  </div>
                </div>
                {settings.navBlurOn && (
                  <WallSlider label="Плотность" value={Math.round((settings.navBlur / 30) * 100)} min={0} max={100} step={1}
                    text={(v) => `${Math.round(v)} %`} onChange={(pct) => onChange({ navBlur: (pct / 100) * 30 })} />
                )}
              </div>
            </section>

            <section className="settings-group wall-stack" aria-labelledby="set-traffic">
              <div>
                <h2 id="set-traffic" className="settings-title">Расход интернета</h2>
                <Choices name="traffic" options={TRAFFIC} value={settings.traffic} units={settings.units} onChange={(traffic) => onChange({ traffic })} />
              </div>
              {modern ? (
                /* «Единицы» as the mockup's row: the name with its current pick as the caption on the left,
                   the two choices as square icon-buttons on the right. */
                <div className="wall-head" aria-labelledby="set-units">
                  <div>
                    <h2 id="set-units" className="settings-title">Единицы</h2>
                    <p className="hint">{UNITS_BTN[settings.units].note}</p>
                  </div>
                  <div className="wall-actions" role="radiogroup" aria-labelledby="set-units">
                    {(['decimal', 'binary'] as const).map((u) => (
                      <button
                        key={u}
                        type="button"
                        role="radio"
                        aria-checked={settings.units === u}
                        title={UNITS.find((o) => o.value === u)?.label}
                        aria-label={UNITS.find((o) => o.value === u)?.label}
                        className={`icon-btn sl unit-btn${settings.units === u ? ' theme-btn-on' : ''}`}
                        onClick={() => onChange({ units: u })}
                      >
                        <span className="unit-glyph mono">{UNITS_BTN[u].text}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div aria-labelledby="set-units">
                  <h2 id="set-units" className="settings-title">Единицы</h2>
                  <Choices name="units" options={UNITS} value={settings.units} units={settings.units} onChange={(units) => onChange({ units })} />
                </div>
              )}
            </section>
          </>
        )}

        {active === 'network' && (
          <>
            <section className="settings-group" aria-labelledby="set-recheck">
              <h2 id="set-recheck" className="settings-title">Проверка соединения</h2>
              <p className="hint">Как часто проверять, что через туннель идёт трафик. Две проверки подряд не удались — на главном появится предупреждение.</p>
              {modern ? (
                <RecheckSlider value={settings.recheckSec} onChange={(recheckSec) => onChange({ recheckSec })} />
              ) : (
                <RecheckChoices value={settings.recheckSec} onChange={(recheckSec) => onChange({ recheckSec })} />
              )}
            </section>

            <DnsCard settings={settings} keyDns={keyDns} onChange={onChange} />

          </>
        )}

        {active === 'app' && (
          <AppSettingsView settings={settings} onChange={onChange} uninstallError={uninstallError} onUninstall={onUninstall} />
        )}

        {active === 'experimental' && (
          <section className="settings-group" aria-labelledby="set-experimental">
            <h2 id="set-experimental" className="settings-title">Debug</h2>
            <p className="hint">То, что ещё проверяется и может работать нестабильно. Виден до выхода из настроек.</p>
            <div className="settings-row">
              <span className="choice-text">
                <span>Системные уведомления</span>
                <span className="hint">
                  Проверить, как система показывает важные сообщения и новости о новой версии. Нажатие на
                  уведомление вернёт в приложение.
                </span>
                {noticeTest === 'sent' && <span className="hint">Отправлено — посмотрите в центре уведомлений.</span>}
                {noticeTest === 'unsupported' && (
                  <span className="hint form-error">Система не показала уведомление: проверьте разрешения в её настройках.</span>
                )}
              </span>
              <Button variant="tonal" onClick={testNotification}>
                Проверить
              </Button>
            </div>
            {isMac && (
              <label className="choice sl">
                <Switch checked={diagnostics} onChange={onDiagnostics} />
                <span className="choice-text">
                  <span>Захват пакетов</span>
                  <span className="hint">
                    При следующем подключении 25 с записывать заголовки пакетов — чтобы найти, где теряется трафик.
                    Итог появится ниже, в журнале.
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
                    Закрытое окно прячется в значок, подключение не обрывается; выйти — через его меню. Нужен трей-хост
                    (tray в waybar или панель с StatusNotifierItem), иначе окно не вернуть без повторного запуска.
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
                    Красит интерфейс палитрой из ~/.cache/wal/colors.json и обновляет её при смене обоев.
                  </span>
                  {settings.pywal && !pywal && (
                    <span className="hint">Палитра не найдена: запустите wal -i с обоями.</span>
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
