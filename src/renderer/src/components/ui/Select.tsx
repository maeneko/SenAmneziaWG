import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'

export interface SelectOption<T extends string> {
  value: T
  label: string
  /** A second line under the label, monospaced and muted (an address, as in the «Серверы» sheet). */
  hint?: string
}

interface SelectProps<T extends string> {
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  id?: string
  disabled?: boolean
  'aria-labelledby'?: string
}

/** Between the field and its list. */
const GAP = 4
/** Room kept free between the list and the window's edge. */
const EDGE = 12
const MAX_HEIGHT = 264

interface Place {
  left: number
  width: number
  top?: number
  bottom?: number
  maxHeight: number
}

/**
 * One choice from a list, in the app's own look: the field is an `.input` pill, the list opens over what is
 * below it — a native <select> opens the system's menu, which no stylesheet reaches. The list is put on <body>
 * with fixed coordinates: a dialog scrolls (`.dialog` has overflow-y: auto) and would clip it otherwise.
 * Keyboard as a select-only combobox (WAI-ARIA): focus stays on the field, arrows move through the list,
 * Enter/Space pick, Escape closes the list — and only the list, not the dialog under it.
 */
export function Select<T extends string>({ value, options, onChange, id, disabled, ...aria }: SelectProps<T>): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [place, setPlace] = useState<Place | null>(null)
  const field = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const listId = useId()
  const optionId = (i: number): string => `${listId}-${i}`
  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value))
  const selected = options[selectedIndex]

  const show = (): void => {
    setActive(selectedIndex)
    setOpen(true)
  }
  const pick = (i: number): void => {
    onChange(options[i].value)
    setOpen(false)
  }

  // Below the field, or above it when the window has more room there.
  useLayoutEffect(() => {
    if (!open || !field.current) return
    const r = field.current.getBoundingClientRect()
    const below = window.innerHeight - r.bottom - GAP - EDGE
    const above = r.top - GAP - EDGE
    setPlace(
      below >= Math.min(MAX_HEIGHT, list.current?.scrollHeight ?? MAX_HEIGHT) || below >= above
        ? { left: r.left, width: r.width, top: r.bottom + GAP, maxHeight: Math.min(MAX_HEIGHT, below) }
        : { left: r.left, width: r.width, bottom: window.innerHeight - r.top + GAP, maxHeight: Math.min(MAX_HEIGHT, above) }
    )
  }, [open])

  // A press elsewhere, the dialog scrolled under it, the window resized or left: the list closes, as a menu does.
  useEffect(() => {
    if (!open) return
    const inside = (target: EventTarget | null): boolean =>
      target instanceof Node && (field.current?.contains(target) === true || list.current?.contains(target) === true)
    const onPointer = (e: PointerEvent): void => {
      if (!inside(e.target)) setOpen(false)
    }
    const onScroll = (e: Event): void => {
      if (!inside(e.target)) setOpen(false)
    }
    const close = (): void => setOpen(false)
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [open])

  // The option the keyboard is on stays in sight.
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active, place])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>): void {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        show()
      }
      return
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setActive((i) => Math.min(options.length - 1, i + 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setActive((i) => Math.max(0, i - 1))
        break
      case 'Home':
        e.preventDefault()
        setActive(0)
        break
      case 'End':
        e.preventDefault()
        setActive(options.length - 1)
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        pick(active)
        break
      case 'Escape':
        // Dialog.tsx closes on Escape from the document: the list is what this Escape is for.
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
        break
      case 'Tab':
        setOpen(false)
        break
    }
  }

  return (
    <>
      <button
        ref={field}
        id={id}
        type="button"
        className={`select-field sl${open ? ' select-field-open' : ''}`}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? optionId(active) : undefined}
        disabled={disabled}
        onKeyDown={onKeyDown}
        // A click from the keyboard (detail 0) was already handled in onKeyDown.
        onClick={(e) => {
          if (e.detail === 0) return
          if (open) setOpen(false)
          else show()
        }}
        {...aria}
      >
        <span className="select-value">{selected?.label}</span>
        <Icon name="chevron" size={18} className="select-chevron" />
      </button>
      {open &&
        createPortal(
          <ul
            ref={list}
            id={listId}
            role="listbox"
            className="select-list"
            aria-labelledby={aria['aria-labelledby']}
            style={place ? { ...place } : { visibility: 'hidden' }}
          >
            {options.map((o, i) => (
              <li
                key={o.value}
                id={optionId(i)}
                data-index={i}
                role="option"
                aria-selected={i === selectedIndex}
                className={`select-option sl${i === active ? ' select-option-active' : ''}`}
                // The focus stays on the field: a press on an option must not take it away.
                onPointerDown={(e) => e.preventDefault()}
                onPointerEnter={() => setActive(i)}
                onClick={() => pick(i)}
              >
                <span className="select-option-text">
                  <span>{o.label}</span>
                  {o.hint && <span className="select-option-hint mono">{o.hint}</span>}
                </span>
                {i === selectedIndex && <Icon name="check" size={18} />}
              </li>
            ))}
          </ul>,
          document.body
        )}
    </>
  )
}
