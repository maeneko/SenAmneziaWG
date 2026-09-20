import { useEffect, useState } from 'react'
import type { ImportResult } from '@shared/types'
import { endpointHost } from '../lib/format'
import { Button } from './ui'

/** Exit of the field (or the server table) before the other one comes in. */
const SWAP_MS = 220

export type KeyFace = 'field' | 'server'

interface KeyFieldProps {
  id: string
  link: string
  onLink: (link: string) => void
  preview: ImportResult | null
  error: string | null
  /** Saving: the key can no longer be changed. */
  locked: boolean
  /** Enter in the field. A key is one line, so Enter never inserts a line break. */
  onSubmit: () => void
  /** After each swap: callers retitle the screen or move focus. */
  onFace?: (face: KeyFace) => void
  autoFocus?: boolean
  className?: string
}

/**
 * The vpn:// key field. Once the key parses, the field gives way to a small table with the
 * server's name and IP and a «Сменить ключ» button, which brings the empty field back.
 */
export function KeyField({ id, link, onLink, preview, error, locked, onSubmit, onFace, autoFocus, className = '' }: KeyFieldProps): React.JSX.Element {
  const valid = preview?.ok === true
  const [face, setFace] = useState<KeyFace>('field')
  const [swapping, setSwapping] = useState(false)
  // The first field may come in with the caller's own entrance; later swaps animate on their own.
  const [swapped, setSwapped] = useState(false)

  const swapTo = (next: KeyFace): void => {
    setSwapping(true)
    setTimeout(() => {
      setFace(next)
      setSwapped(true)
      setSwapping(false)
      onFace?.(next)
    }, SWAP_MS)
  }

  useEffect(() => {
    if (valid && face === 'field' && !swapping) swapTo('server')
  }, [valid])

  const changeKey = (): void => {
    onLink('')
    swapTo('field')
  }

  const classes = ['key-slot', swapping ? 'key-slot-out' : '', swapped ? 'key-slot-swapped' : '', className]
  return (
    <div className={classes.filter(Boolean).join(' ')}>
      {face === 'server' && preview?.ok ? (
        <div className="key-server key-swap">
          <dl className="key-table">
            <div>
              <dt>Название</dt>
              <dd>{preview.tunnel.name}</dd>
            </div>
            <div>
              <dt>IP</dt>
              <dd className="mono">{endpointHost(preview.tunnel.endpoint)}</dd>
            </div>
          </dl>
          <Button variant="tonal" block disabled={locked} onClick={changeKey}>
            Сменить ключ
          </Button>
        </div>
      ) : (
        <textarea
          id={id}
          className="key-input key-swap mono"
          placeholder="vpn://…"
          rows={4}
          value={link}
          autoFocus={autoFocus || swapped}
          autoComplete="off"
          spellCheck={false}
          readOnly={locked}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-status`}
          onChange={(e) => onLink(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            onSubmit()
          }}
        />
      )}
      <div id={`${id}-status`} aria-live="polite">
        {error && <p className="form-error">{error}</p>}
      </div>
    </div>
  )
}
