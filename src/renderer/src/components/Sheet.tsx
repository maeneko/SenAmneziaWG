import { useEffect, useRef, useState, type ReactNode } from 'react'

/** Matches the longest transition in .sheet-layer; unmount only after the slide-out has played. */
const EXIT_MS = 220
/** A hand that moved less than this pressed, not pulled. */
const PULL_SLOP = 6
/** Pulled this far (or a third of the panel, if that is less), let go, the sheet closes. */
const PULL_CLOSE = 120
/** Let go moving down faster than this (px/ms), the sheet closes however short the pull. */
const PULL_FLICK = 0.6
/** A pause in the wheel this long ends a trackpad gesture; the next one starts afresh. */
const WHEEL_GAP = 160

interface SheetProps {
  open: boolean
  title: string
  onClose: () => void
  /** Sits in the top right corner, on the title's line. */
  action?: ReactNode
  children: ReactNode
}

/**
 * Bottom sheet over the page area only: the server bar and the navigation bar under it stay visible
 * and usable, so it is not modal. The page behind it is made inert by the caller.
 * Keys are handled on the panel itself, not the document, so a dialog opened from inside
 * (e.g. «Удалить сервер?») closes on Escape without taking the sheet with it.
 */
export function Sheet({ open, title, onClose, action, children }: SheetProps): React.JSX.Element | null {
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      setMounted(true)
      // Two frames: the closed state must be painted once for the transition to run.
      let second = 0
      const first = requestAnimationFrame(() => (second = requestAnimationFrame(() => setShown(true))))
      return () => {
        cancelAnimationFrame(first)
        cancelAnimationFrame(second)
      }
    }
    setShown(false)
    const t = setTimeout(() => setMounted(false), EXIT_MS)
    return () => clearTimeout(t)
  }, [open])

  useEffect(() => {
    if (!mounted) return
    const previous = document.activeElement as HTMLElement | null
    const panel = ref.current
    const target = panel?.querySelector<HTMLElement>('[aria-current="true"]') ?? panel?.querySelector<HTMLElement>('button:not(:disabled)')
    target?.focus({ preventScroll: true })
    return () => {
      // Hand focus back unless the user already moved it somewhere else (e.g. the navigation bar).
      if (!document.activeElement || document.activeElement === document.body) previous?.focus()
    }
  }, [mounted])

  // Pulled down: the panel follows the hand and the dimming fades with it; let go far enough (or flicked), it closes
  // from where it is, otherwise it springs back. Only while the list is at its top — from further down it scrolls.
  const scrim = useRef<HTMLDivElement>(null)
  const pull = useRef<{ id: number; y: number; at: number; moved: boolean } | null>(null)
  const dragged = useRef(false)
  const pulled = useRef(0)
  const wheel = useRef({ last: 0, pulling: false, timer: 0 })
  const atTop = (): boolean => (ref.current?.querySelector('.sheet-body')?.scrollTop ?? 0) <= 0
  // The panel's own events: not a dialog opened from it, nor a menu put on <body> (React passes both up here).
  const own = (e: React.SyntheticEvent): boolean => {
    const t = e.target as Element
    return ref.current?.contains(t) === true && !t.closest('.scrim-dialog')
  }

  const follow = (dy: number): void => {
    const panel = ref.current
    if (!panel) return
    pulled.current = Math.max(0, dy)
    panel.style.transition = 'none'
    panel.style.transform = `translateY(${pulled.current}px)`
    if (scrim.current) {
      scrim.current.style.transition = 'none'
      scrim.current.style.opacity = String(Math.max(0, 1 - pulled.current / panel.offsetHeight))
    }
  }
  // The styles of the pull come off: the panel goes on from where it was, closing or back up (.sheet-layer).
  const settle = (fast = false): void => {
    const panel = ref.current
    const far = panel ? pulled.current > Math.min(PULL_CLOSE, panel.offsetHeight / 3) : false
    pulled.current = 0
    panel?.classList.remove('sheet-pulling')
    for (const el of [panel, scrim.current]) {
      if (!el) continue
      el.style.transition = ''
      el.style.transform = ''
      el.style.opacity = ''
    }
    if (far || fast) onClose()
  }
  useEffect(() => () => window.clearTimeout(wheel.current.timer), [])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if ((e.pointerType === 'mouse' && e.button !== 0) || !own(e) || !atTop()) return
    pull.current = { id: e.pointerId, y: e.clientY, at: e.timeStamp, moved: false }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const p = pull.current
    if (!p || p.id !== e.pointerId) return
    const dy = e.clientY - p.y
    if (!p.moved) {
      if (dy < PULL_SLOP) {
        if (dy < -PULL_SLOP) pull.current = null // up: not a pull
        return
      }
      p.moved = true
      ref.current?.setPointerCapture(e.pointerId)
      ref.current?.classList.add('sheet-pulling')
      window.getSelection()?.removeAllRanges()
    }
    follow(dy)
  }
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const p = pull.current
    if (!p || p.id !== e.pointerId) return
    pull.current = null
    if (!p.moved) return
    dragged.current = true
    window.setTimeout(() => {
      dragged.current = false
    }, 0)
    const dy = e.clientY - p.y
    settle(e.type === 'pointerup' && dy / Math.max(1, e.timeStamp - p.at) > PULL_FLICK)
  }
  // The click that ends a pull is not a press on the server it was let go over.
  const onClickCapture = (e: React.MouseEvent): void => {
    if (!dragged.current) return
    e.stopPropagation()
    e.preventDefault()
  }
  // Two fingers down on a trackpad scroll towards the top: past it, they pull. Only a gesture that starts at the
  // top does — the coasting of a scroll that has just reached it is not one.
  const onWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
    const w = wheel.current
    const fresh = e.timeStamp - w.last > WHEEL_GAP
    w.last = e.timeStamp
    if (!w.pulling) {
      if (!fresh || e.deltaY >= 0 || !own(e) || !atTop()) return
      w.pulling = true
    }
    follow(pulled.current - e.deltaY)
    window.clearTimeout(w.timer)
    w.timer = window.setTimeout(() => {
      w.pulling = false
      settle()
    }, WHEEL_GAP)
  }

  if (!mounted) return null

  return (
    <div className={`sheet-layer${shown ? ' sheet-shown' : ''}`}>
      <div ref={scrim} className="scrim sheet-scrim" aria-hidden="true" onMouseDown={onClose} />
      <div
        ref={ref}
        className="sheet"
        role="dialog"
        aria-label={title}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          e.stopPropagation()
          onClose()
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClickCapture={onClickCapture}
        onWheel={onWheel}
      >
        <span className="sheet-handle" aria-hidden="true" />
        <div className="sheet-head">
          <h2 className="sheet-title">{title}</h2>
          {action}
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  )
}
