import { useEffect, useRef, useState } from 'react'
import { useLinkPreview } from '../hooks/useLinkPreview'
import { errorText } from '../lib/errors'
import { KeyField, type KeyFace } from './KeyField'
import { Button, Icon, Logo } from './ui'

/** How long the green note stays before the main screen, and the fade-out after it. */
const TOAST_MS = 1600
const LEAVE_MS = 300

type Phase = 'input' | 'saving' | 'done' | 'leaving'

interface WelcomeProps {
  /**
   * The screen must outlive the moment the tunnel list stops being empty, or the green note would
   * never be seen: `true` while importing and celebrating, `false` to hand over to the main screen.
   */
  hold: (on: boolean) => void
}

/** First run: one field for the first vpn:// key; «Далее» appears once the key parses. */
export function Welcome({ hold }: WelcomeProps): React.JSX.Element {
  const [link, setLink] = useState('')
  const [phase, setPhase] = useState<Phase>('input')
  const [saveError, setSaveError] = useState<string | null>(null)
  const preview = useLinkPreview(link)
  const valid = preview?.ok === true
  const [face, setFace] = useState<KeyFace>('field')
  const nextButton = useRef<HTMLButtonElement>(null)

  const onLink = (value: string): void => {
    setLink(value)
    setSaveError(null)
  }

  const onFace = (next: KeyFace): void => {
    setFace(next)
    // The field is gone with the focus in it: hand focus to «Далее», so Enter still continues.
    if (next === 'server') requestAnimationFrame(() => nextButton.current?.focus())
  }

  useEffect(() => {
    if (phase === 'done') {
      const t = setTimeout(() => setPhase('leaving'), TOAST_MS)
      return () => clearTimeout(t)
    }
    if (phase === 'leaving') {
      const t = setTimeout(() => hold(false), LEAVE_MS)
      return () => clearTimeout(t)
    }
    return undefined
  }, [phase, hold])

  async function next(): Promise<void> {
    if (!valid || phase !== 'input') return
    setPhase('saving')
    setSaveError(null)
    hold(true)
    try {
      const result = await window.awg.importLink(link)
      if (result.ok) {
        setPhase('done')
        return
      }
      setSaveError(result.error)
    } catch (e) {
      setSaveError(errorText(e))
    }
    setPhase('input')
    hold(false)
  }

  const error = saveError ?? (preview?.ok === false ? preview.error : null)

  return (
    <div className={`welcome${phase === 'leaving' ? ' welcome-leaving' : ''}`}>
      <div className="titlebar-drag" aria-hidden="true" />
      <div className="welcome-body">
        <div className="welcome-main">
          <Logo className="welcome-logo" />
          <h1 className="welcome-title">Приветствую вас!</h1>
          <label className="welcome-sub" htmlFor="first-key">
            {face === 'server' ? 'Ваш первый сервер:' : 'Вставьте ваш первый ключ:'}
          </label>
          <KeyField
            id="first-key"
            link={link}
            onLink={onLink}
            preview={preview}
            error={error}
            locked={phase !== 'input'}
            onSubmit={() => void next()}
            onFace={onFace}
            autoFocus
          />
        </div>

        <div className="welcome-actions">
          {(phase === 'done' || phase === 'leaving') && (
            <p className="welcome-toast" role="status">
              <Icon name="check" size={18} />
              Приятного пользования! :З
            </p>
          )}
          {valid && (
            <Button ref={nextButton} className="welcome-next" block disabled={phase !== 'input'} onClick={() => void next()}>
              Далее
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
