import { useContext, useEffect, useRef, useState } from 'react'
import type { SettingsTab } from '../lib/settingsTab'
import { SettingsBar } from './SettingsBar'
import { Icon, UiModeContext, type IconName } from './ui'

export type View = 'tunnels' | 'key' | 'profile' | 'settings'

interface BottomNavProps {
  view: View
  onNavigate: (view: View) => void
  /** «Ключ» is there only while a master key is: nothing to show without one. */
  hasKey: boolean
  /** «Профиль» is there only while a master key names an MA7 login. */
  hasProfile: boolean
  /** The settings' own stop bookkeeping — the bar drives it in the modern interface. */
  settingsTab: SettingsTab
  onSettingsTab: (tab: SettingsTab) => void
  /** The hidden «Экспериментальные» stop: five taps on the settings' logo, for this visit only. */
  experimental: boolean
  /** Out of reach while something covers the whole window (the removal screen). */
  inert?: boolean
}

/** Whether an item that comes and goes was already there when the window opened: then it is simply there. */
function usePresent(shown: boolean): boolean {
  const [present, setPresent] = useState(shown)
  useEffect(() => {
    if (!shown) setPresent(false)
  }, [shown])
  return present
}

interface Destination {
  id: View
  label: string
  icon: IconName
}

/* The destinations are the same in both interfaces; only their drawing differs. */
const ITEMS: Destination[] = [
  { id: 'tunnels', label: 'Главная', icon: 'home' },
  { id: 'key', label: 'Ключ', icon: 'key' },
  { id: 'profile', label: 'Профиль', icon: 'user' },
  { id: 'settings', label: 'Настройки', icon: 'settings' }
]

/** The filled mate of each stop's outline glyph: the picked stop crossfades one into the other. The
    stroked tunnel has no fill of its own — its one shape sits still in both states. */
const FILLED: Partial<Record<IconName, IconName>> = {
  home: 'homeFill',
  key: 'keyFill',
  user: 'userFill',
  settings: 'settingsFill'
}

/**
 * Where the stop pair rides: on the tunnels' screen without the split, over the centre of the
 * server bar's own middle (leaning a step left); in the wide split, on the same left line the
 * hero's capsules hold; on every other tab pressed to the left line the server list holds —
 * which is read live from the content column, whose frame mirrors the bar wrap's own. The bar
 * exists only on the tunnels' screen; its width follows the server name and the pair's own
 * width breathes with the labels, so both are measured live and the offset is handed to CSS
 * as --bn-lead.
 */
function useDockedToBar(nav: React.RefObject<HTMLElement | null>, pair: Array<React.RefObject<HTMLElement | null>>, station: React.RefObject<number | null>, watching: unknown[]): void {
  useEffect(() => {
    const el = nav.current
    if (!el) return
    const dock = (): void => {
      // The settings' own bar stands in this very element while it lasts: nothing of the pair's
      // docking applies to it, so the dock stands down (and removes a stale lead class) —
      // re-running with the navigator back on stage re-docks as usual.
      if (el.classList.contains('fsn')) {
        el.classList.remove('sn-docked')
        return
      }
      // The narrow modern window keeps the legacy centring: the capsule group strides the window's
      // own centre, the round stop hanging off it to the right — so no bar docking here, the lead
      // holds half of what is left after the capsule.
      const shell = document.querySelector('.app')
      if (!shell) {
        el.classList.remove('sn-docked')
        return
      }
      if (shell.classList.contains('app-narrow') && shell.classList.contains('ui-modern')) {
        const navBox = el.getBoundingClientRect()
        const groupBox = pair[0]!.current?.getBoundingClientRect()
        const roundBox = pair[1]!.current?.getBoundingClientRect()
        // The legacy centring is a visual one: the whole strip — the capsule with the round stop
        // hanging off it — strides the window's own centre, so the spacer holds half of what is left.
        if (!groupBox || !roundBox) {
          el.classList.remove('sn-docked')
          return
        }
        const pairWidth = roundBox.right - groupBox.left
        // A hair left of true centre, the person's calibration; the fit clamp still guards the frame.
        const lead = Math.max(0, Math.round(Math.max(0, (navBox.width - 32 - pairWidth) / 2 - 8)))
        el.style.setProperty('--bn-lead', `${lead}px`)
        el.classList.add('sn-docked')
        return
      }
      const bar = document.querySelector<HTMLElement>('.server-bar')
      const boxes = pair.map((r) => r.current?.getBoundingClientRect())
      if (boxes.some((b) => !b)) {
        el.classList.remove('sn-docked')
        return
      }
      const navBox = el.getBoundingClientRect()
      const groupBox = boxes[0]!
      const roundBox = boxes[1]!
      const pairWidth = roundBox.right - groupBox.left
      // If the pair would not fit, the lead is pulled back so nothing leaves the frame.
      const fit = Math.max(0, navBox.width - 32 - pairWidth)
      const barBox = bar?.getBoundingClientRect()
      const split = document.querySelector('.tunnels-split')
      let lead: number
      if (bar && barBox && bar.offsetParent !== null && !split) {
        // The capsule holds the bar's middle, leaning a step left; the round stop hangs off to the
        // right of it like its own button.
        station.current = barBox.left + barBox.width / 2 - 52
        // 16px is the bar's own side padding: its content line begins there.
        lead = Math.min(Math.max(0, station.current! - groupBox.width / 2 - (navBox.left + 16)), fit)
      } else if (split && barBox && bar && bar.offsetParent !== null) {
        // The split lines the pair up with the hero's own capsules: the pick capsule stands on
        // the content line plus the wrap's 12px lead, and the navigator stands on that same line.
        const capBox = split.querySelector('.server-bar')?.getBoundingClientRect()
        const line = capBox ? Math.round(capBox.left) : 44
        lead = Math.min(Math.max(20, line - (navBox.left + 16)), fit)
      } else {
        // Any other tab: the navigation presses to the left line the server list holds, a breath off
        // the very line. The narrow layout pressed the bar to the window's own side (its wrap's
        // margin is zeroed), the wide one keeps both at the content column's line — read from the
        // page's own body frame.
        const app = document.querySelector('.app')
        const narrow = !app || app.classList.contains('app-narrow')
        if (narrow) lead = 20
        else {
          const body = document.querySelector<HTMLElement>('.content-body')
          const bodyBox = body?.getBoundingClientRect()
          const pad = body ? parseFloat(getComputedStyle(body).paddingLeft) : 0
          lead = Math.max(20, (bodyBox ? bodyBox.left : 0) + pad - (navBox.left + 16) + 20)
        }
      }
      el.style.setProperty('--bn-lead', `${Math.round(lead)}px`)
      el.classList.add('sn-docked')
    }
    dock()
    const observer = new ResizeObserver(dock)
    observer.observe(document.documentElement)
    const bar = document.querySelector<HTMLElement>('.server-bar')
    if (bar) observer.observe(bar)
    // The content column resizes with the whole page: watching it keeps the station fresh where the
    // window's own resize event is not enough (a shell that resizes the frame around the page).
    const body = document.querySelector<HTMLElement>('.content-body')
    if (body) observer.observe(body)
    for (const r of pair) if (r.current) observer.observe(r.current)
    window.addEventListener('resize', dock)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', dock)
    }
    // The watch list follows the callers' flows rather than the hooks' lint rule's reading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, watching)
}

/** The expressive bar: a capsule of quiet icons, the picked stop unrolled with its label, settings alone. */
function Expressive({ view, onNavigate, hasKey, hasProfile, settingsTab, onSettingsTab, experimental, inert, growing }: {
  view: View
  onNavigate: (view: View) => void
  hasKey: boolean
  hasProfile: boolean
  settingsTab: SettingsTab
  onSettingsTab: (tab: SettingsTab) => void
  experimental: boolean
  inert?: boolean
  growing: (id: View) => boolean
}): React.JSX.Element {
  const shown = (id: View): boolean => (id === 'key' ? hasKey : id === 'profile' ? hasProfile : true)
  const [stop, alone] = [ITEMS.slice(0, 3), ITEMS[3]]
  const nav = useRef<HTMLElement>(null)
  const group = useRef<HTMLDivElement>(null)
  const round = useRef<HTMLButtonElement>(null)
  // The pair's horizontal station over the bar's middle, remembered across the pages.
  const station = useRef<number | null>(null)

  /* On the settings' screen the sections take the navigator over: the same bar element stands at
     the same floor, its quiet stops yield to the settings' own set (the back arrow leading them).
     Per M3 «fade-through»: the outgoing set dips to rest in 90ms, the incoming one grows in over
     the next 210ms on the emphasized curve — one set owns the stage at a time, canonically. */
  type Stage = 'nav' | 'bar'
  const target: Stage = view === 'settings' ? 'bar' : 'nav'
  // A page opened straight on the settings rises there with no ceremony — the persisted view.
  const [stage, setStage] = useState<Stage>(target)
  const [swap, setSwap] = useState<'' | 'fsn-out' | 'fsn-in'>('')
  useEffect(() => {
    if (stage === target) return
    setSwap('fsn-out')
    const t = setTimeout(() => {
      setStage(target)
      setSwap('fsn-in')
    }, 90)
    return () => clearTimeout(t)
  }, [target, stage])
  const onSwapEnd = (e: React.AnimationEvent): void => {
    if (e.animationName === 'fsn-thru-in') setSwap('')
  }

  useDockedToBar(nav, [group, round], station, [view, hasKey, hasProfile, stage])
  if (stage === 'bar') {
    return (
      <nav className={`bottom-nav fsn${swap ? ` ${swap}` : ''}`} aria-label="Разделы настроек" inert={inert} onAnimationEnd={onSwapEnd}>
        <SettingsBar
          tab={settingsTab}
          experimental={experimental}
          onTab={onSettingsTab}
          onHome={() => onNavigate('tunnels')}
        />
      </nav>
    )
  }
  return (
    <nav className={`bottom-nav${swap ? ` ${swap}` : ''}`} aria-label="Разделы" inert={inert} onAnimationEnd={onSwapEnd}>
      <div ref={group} className="bn-group">
        {stop.filter((item) => shown(item.id)).map((item) => (
          <button
            key={item.id}
            type="button"
            className={`bn-item${growing(item.id) ? ' bn-item-in' : ''}`}
            aria-current={view === item.id ? 'page' : undefined}
            title={item.label}
            onClick={() => onNavigate(item.id)}
          >
            <span className="bn-glyph">
              {/* Only a stop with a filled mate carries the two classes: the tunnel's single layer
                  keeps no class, so the crossfade rules never touch it. */}
              <Icon name={item.icon} size={24} className={FILLED[item.icon] ? 'bn-glyph-line' : undefined} />
              {FILLED[item.icon] ? <Icon name={FILLED[item.icon]!} size={24} className="bn-glyph-fill" /> : null}
            </span>
            <span className="bn-label">
              <span className="bn-text">{item.label}</span>
            </span>
          </button>
        ))}
      </div>
      <button
        ref={round}
        type="button"
        className="bn-item bn-round"
        aria-current={view === 'settings' ? 'page' : undefined}
        title={alone.label}
        onClick={() => onNavigate(alone.id)}
      >
        <span className="bn-glyph">
          {/* Ibid: the round stop's settings glyph owns a fill, the classes are safe to carry. */}
          <Icon name={alone.icon} size={24} className={FILLED[alone.icon] ? 'bn-glyph-line' : undefined} />
          {FILLED[alone.icon] ? <Icon name={FILLED[alone.icon]!} size={24} className="bn-glyph-fill" /> : null}
        </span>
        {/* On settings' own screen the label unrolls here too, like on the capsuled stops. */}
        <span className="bn-label">
          <span className="bn-text">{alone.label}</span>
        </span>
      </button>
    </nav>
  )
}

/** The 0.9.0 bar (MD3 spec): every stop a pill over its own icon, the label under it, settings in the row. */
function Legacy({ view, onNavigate, hasKey, hasProfile, inert, growing }: {
  view: View
  onNavigate: (view: View) => void
  hasKey: boolean
  hasProfile: boolean
  inert?: boolean
  growing: (id: View) => boolean
}): React.JSX.Element {
  const shown = (id: View): boolean => (id === 'key' ? hasKey : id === 'profile' ? hasProfile : true)
  return (
    <nav className="bottom-nav" aria-label="Разделы" inert={inert}>
      {ITEMS.filter((item) => shown(item.id)).map((item) => (
        <button
          key={item.id}
          type="button"
          className={`bn-item${growing(item.id) ? ' bn-item-in' : ''}`}
          aria-current={view === item.id ? 'page' : undefined}
          onClick={() => onNavigate(item.id)}
        >
          <span className="bn-indicator">
            <Icon name={item.icon} size={24} />
          </span>
          <span className="bn-label">{item.label}</span>
        </button>
      ))}
    </nav>
  )
}

/**
 * MD3 expressive navigation bar: a floating capsule whose quiet stops are bare 24px icons, and the stop
 * we are on opens out — the icon in a low ring, the label unrolling beside it. «Настройки» is its own
 * round button to the right, a hand's width off the capsule. There is no «Выход»: closing the window
 * quits, and the tunnel and the Windows service go down with the process however it ends.
 *
 * «Легаси» in Настройки → Интерфейс returns the 0.9.0 drawing: every stop an icon in a pill with the
 * label under it, all of the stops in the row together.
 */
export function BottomNav({ view, onNavigate, hasKey, hasProfile, settingsTab, onSettingsTab, experimental, inert }: BottomNavProps): React.JSX.Element {
  const mode = useContext(UiModeContext)
  // «Ключ» and «Профиль» grow in when the master key appears; one that was already there when the window
  // opened, or when the page was reloaded, is simply there.
  const keyPresent = usePresent(hasKey)
  const profilePresent = usePresent(hasProfile)
  const growing = (id: View): boolean => (id === 'key' && !keyPresent) || (id === 'profile' && !profilePresent)
  return mode === 'legacy' ? (
    <Legacy view={view} onNavigate={onNavigate} hasKey={hasKey} hasProfile={hasProfile} inert={inert} growing={growing} />
  ) : (
    <Expressive
      view={view}
      onNavigate={onNavigate}
      hasKey={hasKey}
      hasProfile={hasProfile}
      settingsTab={settingsTab}
      onSettingsTab={onSettingsTab}
      experimental={experimental}
      inert={inert}
      growing={growing}
    />
  )
}
