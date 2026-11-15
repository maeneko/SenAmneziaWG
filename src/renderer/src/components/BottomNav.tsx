import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
      const shell = document.querySelector('.app')
      if (!shell) {
        el.classList.remove('sn-docked')
        el.style.removeProperty('--bn-wheel')
        return
      }
      // The wide modern window keeps the navigator on the split's own axis: the stack that owns
      // Home's half — the ring, the routing chip, the server bar's capsule — stands on a 380px
      // column a breath in from the pane's left line, and the pair rides under that column, not
      // under the raw window's half (the two drift apart once the 1100px column is capped: 84px
      // at 1600). The settings' bar rides the same axis over their split; without one — the
      // keyless hero — the wheel is zero.
      const wide = shell.classList.contains('app-wide') && shell.classList.contains('ui-modern')
      if (wide) {
        el.classList.remove('sn-docked')
        const split = document.querySelector('.tunnels-split')
        const anchor = split?.querySelector('.power') ?? split?.querySelector('.server-bar') ?? null
        // The pair's untransformed middle: offsetLeft/offsetWidth carry the layout, never the
        // wheel the element already rides on (getBoundingClientRect would fold it in).
        const base = shell.getBoundingClientRect().left + el.offsetLeft + el.offsetWidth / 2
        const axis = anchor
          ? (() => {
              const r = anchor.getBoundingClientRect()
              return r.left + r.width / 2
            })()
          : base
        el.style.setProperty('--bn-wheel', `${Math.round(axis - base)}px`)
        return
      }
      el.style.removeProperty('--bn-wheel')
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
  // The right surface's holder: the round settings stop on the pages, the sections' capsule on
  // the settings — one element, so its width can follow the morph.
  const round = useRef<HTMLDivElement>(null)
  // The pair's horizontal station over the bar's middle, remembered across the pages.
  const station = useRef<number | null>(null)

  /* On the settings' screen the sections take the navigator over, the way Chumpy's bar morphs:
     the left capsule collapses into the round «Назад», while the round settings stop unfolds into
     the sections' capsule — two surfaces of one bar, each holding its place. Per M3 «fade-through»
     the handover dips the leaving face to rest in 90ms and grows the arriving one over the next
     210ms; across the same breath the surfaces' widths walk from the leaving measure to their own
     on the spring, so the bar reads as one shape changing, never two bars trading. */
  type Stage = 'nav' | 'bar'
  const target: Stage = view === 'settings' ? 'bar' : 'nav'
  // A page opened straight on the settings rises there with no ceremony — the persisted view.
  const [stage, setStage] = useState<Stage>(target)
  const [swap, setSwap] = useState<'' | 'fsn-out' | 'fsn-in'>('')
  const morphFrom = useRef<{ group: number; round: number } | null>(null)
  const morphTimer = useRef<number | null>(null)
  const morphRaf = useRef<number | null>(null)

  useEffect(() => {
    if (stage === target) return
    // The leaving face is still on stage at this very moment, before its 90ms dip: its surfaces'
    // widths are what the arriving face starts from.
    morphFrom.current = { group: group.current?.offsetWidth ?? 0, round: round.current?.offsetWidth ?? 0 }
    setSwap('fsn-out')
    const t = setTimeout(() => {
      setStage(target)
      setSwap('fsn-in')
    }, 90)
    return () => clearTimeout(t)
  }, [target, stage])

  /* The surfaces change owners between the faces — the left capsule becomes the back stop, the
     round button the sections' capsule — and their widths follow on the same spring: freeze the
     arriving face at the leaving face's measure for a frame, then walk each surface to its own. */
  useLayoutEffect(() => {
    const from = morphFrom.current
    morphFrom.current = null
    const a = group.current
    const b = round.current
    if (morphRaf.current !== null) cancelAnimationFrame(morphRaf.current)
    if (morphTimer.current !== null) clearTimeout(morphTimer.current)
    morphRaf.current = null
    morphTimer.current = null
    if (!from || !a || !b || from.group === 0 || from.round === 0) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const hold = (el: HTMLElement): void => {
      el.style.transition = 'none'
      el.style.overflow = 'clip'
    }
    hold(a)
    hold(b)
    a.style.width = `${from.group}px`
    b.style.width = `${from.round}px`
    void a.offsetWidth
    // The arriving sizes: measured with the new faces already in place, then frozen back at the
    // leaving measure for the one frame the spring starts from.
    a.style.width = ''
    b.style.width = ''
    // The docking spacer is still mid-walk from the pages' lead for a moment, so the row reads
    // narrower than it lands: the sections' capsule is measured by its own content instead, or by
    // the share the row can hold on the tightest windows. Otherwise the width settles on that
    // momentary squeeze and snaps to its true measure as the inline styles are cleared.
    const inner = b.firstElementChild as HTMLElement | null
    const content = inner ? Math.max(b.offsetWidth, inner.scrollWidth) : b.offsetWidth
    const nb = nav.current
    let room = Number.POSITIVE_INFINITY
    if (nb) {
      const cs = getComputedStyle(nb)
      const padding = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
      room = nb.offsetWidth - padding - a.offsetWidth - parseFloat(getComputedStyle(b).marginLeft)
    }
    const to = { group: a.offsetWidth, round: Math.min(content, Math.max(0, room)) }
    a.style.width = `${from.group}px`
    b.style.width = `${from.round}px`
    void a.offsetWidth
    morphRaf.current = requestAnimationFrame(() => {
      a.style.transition = 'width 420ms cubic-bezier(0.34, 1.4, 0.64, 1)'
      b.style.transition = 'width 420ms cubic-bezier(0.34, 1.4, 0.64, 1)'
      a.style.width = `${to.group}px`
      b.style.width = `${to.round}px`
      morphTimer.current = window.setTimeout(() => {
        for (const el of [a, b]) {
          el.style.transition = ''
          el.style.overflow = ''
          el.style.width = ''
        }
        morphTimer.current = null
      }, 460)
    })
  }, [stage])

  useEffect(() => () => {
    if (morphRaf.current !== null) cancelAnimationFrame(morphRaf.current)
    if (morphTimer.current !== null) clearTimeout(morphTimer.current)
  }, [])

  const onSwapEnd = (e: React.AnimationEvent): void => {
    if (e.animationName === 'fsn-thru-in') setSwap('')
  }

  useDockedToBar(nav, [group, round], station, [view, hasKey, hasProfile, stage])
  return (
    <nav
      ref={nav}
      className={`bottom-nav${stage === 'bar' ? ' fsn' : ''}${swap ? ` ${swap}` : ''}`}
      aria-label={stage === 'bar' ? 'Разделы настроек' : 'Разделы'}
      inert={inert}
      onAnimationEnd={onSwapEnd}
    >
      {/* Left surface: the stops' capsule on the pages, the round «Назад» on the sections. */}
      <div ref={group} className="bn-group">
        {stage === 'bar' ? (
          <button type="button" className="bn-item bn-back" title="На главную" aria-label="На главную" onClick={() => onNavigate('tunnels')}>
            <span className="bn-glyph">
              <Icon name="back" size={24} />
            </span>
          </button>
        ) : (
          stop.filter((item) => shown(item.id)).map((item) => (
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
          ))
        )}
      </div>
      {/* Right surface: the round settings stop on the pages, the sections' capsule on the settings. */}
      <div ref={round} className="bn-slot">
        {stage === 'bar' ? (
          <SettingsBar tab={settingsTab} experimental={experimental} onTab={onSettingsTab} />
        ) : (
          <button type="button" className="bn-item bn-round" title={alone.label} onClick={() => onNavigate(alone.id)}>
            <span className="bn-glyph">
              {/* Ibid: the round stop's settings glyph owns a fill, the classes are safe to carry. */}
              <Icon name={alone.icon} size={24} className={FILLED[alone.icon] ? 'bn-glyph-line' : undefined} />
              {FILLED[alone.icon] ? <Icon name={FILLED[alone.icon]!} size={24} className="bn-glyph-fill" /> : null}
            </span>
          </button>
        )}
      </div>
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
