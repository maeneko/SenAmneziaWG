import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react'

interface DialogProps {
  title: string
  onClose: () => void
  children: ReactNode
  actions: ReactNode
  /**
   * The step of a dialog that goes through several (ReportDialog: the form, the review, «отправлен»). A new value
   * plays the change instead of swapping at once: what was shown leaves upward, the new rises from below, and the
   * dialog's height flows from one to the other (design.md §6). Without it the content just changes in place.
   */
  step?: string
  /**
   * Leaving plays too: the dialog drops and fades with its scrim before onClose is called (design.md §6, 200ms).
   * Escape and the scrim go through it, and so does `ref.close()` for the page's own buttons. Only for a page whose
   * onClose always closes — a dialog that refused would be left faded out; `canClose` is the way to refuse.
   */
  animateClose?: boolean
  /** False: Escape and the scrim do nothing for now (a request on its way). */
  canClose?: boolean
  /**
   * The height follows the content as it changes in place — what was loading has come, an error showed up — instead
   * of jumping to it: the same flow as between steps (design.md §6).
   */
  fluid?: boolean
  ref?: Ref<DialogHandle>
}

/** What the page can ask of the dialog: to close the way it closes by itself, with `animateClose` animated. */
export interface DialogHandle {
  close(): void
}

/** design.md §6: a leave is short and accelerates; the arrival (CSS, 320ms) decelerates; the height moves on standard. */
const LEAVE_MS = 160
/** The whole dialog's exit, with its scrim (CSS: dialog-out, dialog-scrim-out). */
const EXIT_MS = 200
const HEIGHT_MS = 320
const HEIGHT_EASE = 'cubic-bezier(0.2, 0, 0, 1)'

/** `out`: the old step on its way out; `in`: the new one arriving; `still`: nothing moving (and the first one). */
type Phase = 'still' | 'out' | 'in'

const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches

export function Dialog({ title, onClose, children, actions, step, animateClose, canClose = true, fluid, ref: handle }: DialogProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // The height the dialog last settled at by itself, with no height of ours on it (`fluid`).
  const settled = useRef(0)

  // The newest onClose, for what is set up once and runs later (the keys, the exit's timer): the keys are set up
  // when the dialog opens, so a new handler from the page does not move the focus back to the first field.
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })

  // Closing: at once, or — with animateClose — after the exit has played. Once, however many ways ask for it.
  const [exiting, setExiting] = useState(false)
  const close = (): void => {
    if (exiting) return
    if (!animateClose || reducedMotion()) {
      onClose()
      return
    }
    setExiting(true)
  }
  useEffect(() => {
    if (!exiting) return
    const timer = window.setTimeout(() => closeRef.current(), EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [exiting])
  useImperativeHandle(handle, () => ({ close }))
  // Escape and the scrim, as the dialog's own way out; refused while the page says it cannot close.
  const dismiss = (): void => {
    if (canClose) close()
  }
  const dismissRef = useRef(dismiss)
  useEffect(() => {
    dismissRef.current = dismiss
  })

  // What is on screen. A new `step` first plays the old one out — its last content is kept for that — and only
  // then shows the new one. With reduced motion it changes at once.
  const [shown, setShown] = useState<{ step?: string; phase: Phase }>({ step, phase: 'still' })
  const last = useRef({ title, children, actions })
  if (step !== shown.step && shown.phase !== 'out') {
    setShown(reducedMotion() ? { step, phase: 'still' } : { step: shown.step, phase: 'out' })
  }
  const leaving = shown.phase === 'out'
  if (!leaving && step === shown.step) last.current = { title, children, actions }
  const content = leaving ? last.current : { title, children, actions }

  useEffect(() => {
    if (shown.phase !== 'out') return
    const timer = window.setTimeout(() => setShown({ step, phase: 'in' }), LEAVE_MS)
    return () => window.clearTimeout(timer)
  }, [shown.phase, step])

  // The height: measured with the old step still there, then — once the new one is in — set back to it and let
  // go towards the new one. Clipped meanwhile, so no scroll bar flashes up.
  const fromHeight = useRef(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (shown.phase === 'out') {
      fromHeight.current = el.getBoundingClientRect().height
      return
    }
    if (shown.phase !== 'in') return
    const from = fromHeight.current
    const to = el.getBoundingClientRect().height
    if (!from || Math.abs(from - to) < 1) return
    const reset = (): void => {
      el.style.height = ''
      el.style.overflowY = ''
      el.style.transition = ''
      settled.current = el.offsetHeight
    }
    el.style.height = `${from}px`
    el.style.overflowY = 'hidden'
    void el.offsetHeight // the browser takes the old height first, or there is nothing to move from
    el.style.transition = `height ${HEIGHT_MS}ms ${HEIGHT_EASE}`
    el.style.height = `${to}px`
    const timer = window.setTimeout(reset, HEIGHT_MS + 40)
    return () => {
      window.clearTimeout(timer)
      reset()
    }
  }, [shown])

  // `fluid`: the dialog is watched as it is laid out, and a new height of its own is played from the one before.
  // While a height of ours is on it (this, or a step's flow) it is left alone; once that comes off, a change that
  // happened meanwhile shows as a size of its own and plays then. offsetHeight, not the box on screen: the entrance
  // scales the dialog.
  useLayoutEffect(() => {
    const el = ref.current
    if (!fluid || !el || typeof ResizeObserver === 'undefined') return
    settled.current = el.offsetHeight
    let timer = 0
    const reset = (): void => {
      el.style.height = ''
      el.style.overflowY = ''
      el.style.transition = ''
    }
    const observer = new ResizeObserver(() => {
      if (el.style.height) return
      const from = settled.current
      const to = el.offsetHeight
      settled.current = to
      if (!from || Math.abs(from - to) < 1 || reducedMotion()) return
      el.style.height = `${from}px`
      el.style.overflowY = 'hidden'
      void el.offsetHeight // the browser takes the old height first, or there is nothing to move from
      el.style.transition = `height ${HEIGHT_MS}ms ${HEIGHT_EASE}`
      el.style.height = `${to}px`
      timer = window.setTimeout(reset, HEIGHT_MS + 40)
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
    }
  }, [fluid])

  // The focus was on the step that left: it goes to the new one — to its own autoFocus, or its first field.
  useEffect(() => {
    if (shown.phase !== 'in' || !ref.current || ref.current.contains(document.activeElement)) return
    ref.current.querySelector<HTMLElement>('textarea, input, button:not(:disabled)')?.focus()
  }, [shown])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    // A field with autoFocus has the focus already; otherwise the first one there is.
    if (!ref.current?.contains(document.activeElement)) ref.current?.querySelector<HTMLElement>('textarea, input, button')?.focus()

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dismissRef.current()
      if (e.key !== 'Tab' || !ref.current) return
      // Keep focus inside the modal.
      const items = ref.current.querySelectorAll<HTMLElement>('input, button:not(:disabled), textarea, [href]')
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus()
    }
  }, [])

  return (
    <div
      className={`scrim scrim-dialog${exiting ? ' scrim-dialog-out' : ''}`}
      onMouseDown={(e) => e.target === e.currentTarget && dismiss()}
    >
      <div ref={ref} className={`dialog${exiting ? ' dialog-out' : ''}`} role="dialog" aria-modal="true" aria-label={content.title} inert={exiting}>
        {/* Keyed by the step shown: the arriving one mounts afresh and plays its entrance. The leaving one is inert —
            nothing in it can be pressed on its way out. */}
        <div key={shown.step ?? ''} className={`dialog-step${shown.phase === 'still' ? '' : ` dialog-step-${shown.phase}`}`} inert={leaving}>
          <h2 className="dialog-title">{content.title}</h2>
          <div className="dialog-body">{content.children}</div>
          <div className="dialog-actions">{content.actions}</div>
        </div>
      </div>
    </div>
  )
}
