import { useEffect, useState } from 'react'
import { splitErrorCode } from '../lib/errors'
import { Icon } from './ui'

/** An error's text, with its catalog code after it when there is one: quiet, for quoting to support; a click copies it. */
export function ErrorText({ text }: { text: string }): React.JSX.Element {
  const { code, text: message } = splitErrorCode(text)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  if (!code) return <>{message}</>
  return (
    <>
      {message}
      <span className="error-code-wrap">
        <button
          type="button"
          className="error-code"
          aria-label={copied ? 'Код скопирован' : `Скопировать код ошибки ${code}`}
          title={copied ? 'Скопировано' : 'Скопировать код'}
          onClick={() => void navigator.clipboard.writeText(code).then(() => setCopied(true), () => undefined)}
        >
          {code}
          {copied && <Icon name="check" size={12} />}
        </button>
      </span>
    </>
  )
}
