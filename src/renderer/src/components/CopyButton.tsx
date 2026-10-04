import { useEffect, useState } from 'react'
import { IconButton } from './ui'

/** Copies a value and says so on the button itself for a moment. */
export function CopyButton({ text, label, className }: { text: string; label: string; className?: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <IconButton
      className={className}
      icon={copied ? 'check' : 'copy'}
      label={copied ? 'Скопировано' : label}
      onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true), () => undefined)}
    />
  )
}
