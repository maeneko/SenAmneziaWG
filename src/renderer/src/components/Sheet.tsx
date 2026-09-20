import { useEffect, useRef, useState, type ReactNode } from 'react'

/** Matches the longest transition in .sheet-layer; unmount only after the slide-out has played. */
const EXIT_MS = 220

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

  if (!mounted) return null

  return (
    <div className={`sheet-layer${shown ? ' sheet-shown' : ''}`}>
      <div className="scrim sheet-scrim" aria-hidden="true" onMouseDown={onClose} />
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
