import { useEffect, useState } from 'react'
import type { KeyBindings, PreviewResult } from '@shared/types'
import { endpointHost } from '../lib/format'
import { BindingsBar } from './BindingsBar'
import { Button } from './ui'

/** Exit of the field (or the server table) before the other one comes in. */
const SWAP_MS = 220

export type KeyFace = 'field' | 'server'

interface KeyFieldProps {
  id: string
  link: string
  onLink: (link: string) => void
  preview: PreviewResult | null
  error: string | null
  /** The slots taken before this computer is added, once the server has said (it is asked as the link is pasted). */
  known?: KeyBindings | null
  /** A master key was just registered: the slot it took, shown as a bar that grows by one. */
  bindings?: KeyBindings | null
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
 * The key field (vpn:// or sen://). Once the key parses, the field gives way to a small table with the
 * server's name and IP (for a master key, its name and where it asks for settings) and a «Сменить ключ»
 * button, which brings the empty field back.
 */
export function KeyField({ id, link, onLink, preview, known, bindings, error, locked, onSubmit, onFace, autoFocus, className = '' }: KeyFieldProps): React.JSX.Element {
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
          {'tunnel' in preview ? (
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
          ) : (
            <dl className="key-table">
              <div>
                <dt>Мастер-ключ</dt>
                <dd>{preview.master.name || 'Без названия'}</dd>
              </div>
              <div>
                <dt>Сервер</dt>
                <dd className="mono">{preview.master.address}</dd>
              </div>
            </dl>
          )}
          {/* Known at once: it simply stands there. Adding takes a slot, and the bar grows by it. */}
          {bindings ? (
            <BindingsBar from={known?.used ?? Math.max(0, bindings.used - 1)} to={bindings.used} limit={bindings.limit} />
          ) : known ? (
            <BindingsBar from={known.used} to={known.used} limit={known.limit} />
          ) : (
            locked && <PendingBar />
          )}
          <Button variant="tonal" block disabled={locked} onClick={changeKey}>
            Сменить ключ
          </Button>
        </div>
      ) : (
        <textarea
          id={id}
          className="key-input key-swap mono"
          placeholder="vpn:// или sen://…"
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

/** While the key is being registered the count is not known yet: an empty bar with something moving in it. */
function PendingBar(): React.JSX.Element {
  return (
    <div className="key-bindings" role="status" aria-label="Регистрирую устройство">
      <div className="key-bindings-head">
        <span>Привязки</span>
        <span>…</span>
      </div>
      <div className="key-meter key-meter-pending">
        <span />
      </div>
    </div>
  )
}
