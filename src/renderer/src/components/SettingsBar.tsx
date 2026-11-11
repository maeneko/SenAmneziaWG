import { useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from './ui'
import type { SettingsTab } from '../lib/settingsTab'

interface SettingsStop {
  id: SettingsTab
  label: string
  icon: IconName
  /* The one stop with a filled mate: the crossfading gear. */
  fill?: IconName
}

/* The settings sections ride the bottom bar as stops — the same Material source as the icon set.
   «Приложение» walks leftmost carrying the gear: it is the ordinary settings stop, with the shipped
   outline⇄fill crossfade on it. */
const TABS: SettingsStop[] = [
  { id: 'app', label: 'Приложение', icon: 'settings', fill: 'settingsFill' },
  { id: 'interface', label: 'Интерфейс', icon: 'menu' },
  { id: 'network', label: 'Сеть', icon: 'globe' },
  { id: 'diagnostics', label: 'Диагностика', icon: 'diagnostics' }
]
const EXPERIMENTAL: SettingsStop = { id: 'experimental', label: 'Экспериментальные', icon: 'experimental' }

const stopsFor = (experimental: boolean): SettingsStop[] => (experimental ? [...TABS, EXPERIMENTAL] : TABS)

interface SettingsBarProps {
  tab: SettingsTab
  /** The hidden «Экспериментальные» stop: five taps on the logo, only for this visit. */
  experimental: boolean
  onTab: (tab: SettingsTab) => void
  /** «Назад» dips the bar out and lands on the main screen. */
  onHome: () => void
}

/**
 * The settings' own bar content: the back stop, then the sections. One selection slab glides
 * between the stops on the spring while the stop content only crossfades — per M3 the transport
 * never sits in the content. The gear takes its stage turning: it arrives two teeth off and
 * springs into rest, and a demoted one turns away into rest (its own class clears on the
 * animation's end).
 *
 * The navigator renders this inside its one bottom-nav element, so the root here is the group.
 */
export function SettingsBar({ tab, experimental, onTab, onHome }: SettingsBarProps): React.JSX.Element {
  const stops = stopsFor(experimental)
  // A persisted tab that this visit cannot show (the relic of the logo's five taps) folds to «Приложение».
  const active = stops.some((s) => s.id === tab) ? tab : 'app'

  const group = useRef<HTMLDivElement>(null)
  const pill = useRef<HTMLSpanElement>(null)
  const landed = useRef(false)
  const [gearOut, setGearOut] = useState(false)
  const prev = useRef(active)
  const activeRef = useRef(active)
  activeRef.current = active

  /* The slab's steered geometry. Sibling widths animate (the label unroll/collapse), so a live read
     freezes the slab on a mid-flight number: a settled twin of the whole row materializes in final
     layout — clones don't replay transitions — and its geometry is what the slab glides to. */
  const place = (): void => {
    const g = group.current
    const p = pill.current
    if (!g || !p) return
    const sel = `[data-fsn="${activeRef.current}"]`
    if (!g.querySelector(sel)) {
      p.style.opacity = '0'
      return
    }
    const twin = g.cloneNode(true) as HTMLElement
    twin.querySelector('.fsn-pill')?.remove()
    twin.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;pointer-events:none'
    twin.style.width = `${g.getBoundingClientRect().width}px`
    g.appendChild(twin)
    const geo = twin.querySelector<HTMLElement>(sel)
    const left = geo?.offsetLeft ?? 0
    const width = geo?.offsetWidth ?? 0
    twin.remove()
    p.style.opacity = '1'
    if (!landed.current) {
      landed.current = true
      p.classList.add('fsn-quiet') // the first placement lands, it doesn't fly
    }
    p.style.left = `${left}px`
    p.style.width = `${width}px`
    if (p.classList.contains('fsn-quiet')) {
      requestAnimationFrame(() => requestAnimationFrame(() => p.classList.remove('fsn-quiet')))
    }
  }

  useEffect(place, [active, experimental])
  /* Both widths are measured the way they land: the first placements' frames (the group still
     assembling) re-run the same steady state — settle measured on the settled row. */
  useEffect(() => {
    const ch = setTimeout(place, 420)
    return () => clearTimeout(ch)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, experimental])

  /* The turn-out marker: set on a real demotion only, cleared on the spin's own end. */
  useEffect(() => {
    if (prev.current === 'app' && active !== 'app') setGearOut(true)
    prev.current = active
  }, [active])

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const list = [...(group.current?.querySelectorAll('[data-fsn]') ?? [])] as HTMLElement[]
    const i = list.findIndex((el) => el.getAttribute('data-fsn') === activeRef.current)
    const next = list[(i + (e.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length]
    if (!next) return
    next.focus()
    const id = next.getAttribute('data-fsn') as SettingsTab
    if (id !== activeRef.current) onTab(id)
  }

  return (
    <div ref={group} className="bn-group" onKeyDown={onKey}>
      {/* The selection slab lives under the stops: it glides, the stops only crossfade. */}
      <span ref={pill} className="fsn-pill" aria-hidden="true" />
      <button type="button" className="bn-item" title="На главную" aria-label="На главную" onClick={onHome}>
        <span className="bn-glyph">
          <Icon name="back" size={24} />
        </span>
      </button>
      {stops.map((s) => {
        const on = s.id === active
        return (
          <button
            key={s.id}
            type="button"
            data-fsn={s.id}
            role="tab"
            id={`settings-tab-${s.id}`}
            aria-selected={on}
            aria-controls={`settings-panel-${s.id}`}
            aria-current={on ? 'page' : undefined}
            tabIndex={on ? 0 : -1}
            title={s.label}
            className={`bn-item${s.id === 'app' && gearOut ? ' fsn-gearout' : ''}`}
            onAnimationEnd={(e) => {
              /* The glyph's children also send animationend (the outline⇄fill crossfade bubbles
                 it), so match by name, not origin. */
              if (e.animationName === 'fsn-spin-out') setGearOut(false)
            }}
            onClick={() => onTab(s.id)}
          >
            <span className="bn-glyph">
              {s.fill ? (
                <>
                  <Icon name={s.icon} size={24} className="bn-glyph-line" />
                  <Icon name={s.fill} size={24} className="bn-glyph-fill" />
                </>
              ) : (
                <Icon name={s.icon} size={24} />
              )}
            </span>
            <span className="bn-label">
              <span className="bn-text">{s.label}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
