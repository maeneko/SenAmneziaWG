import { useEffect, useState } from 'react'
import type { KeyBindings, PreviewResult } from '@shared/types'

/** Parses a vpn:// or sen:// link as it is typed (debounced), so a bad link is explained before anything is pressed. */
export function useLinkPreview(link: string): PreviewResult | null {
  const [preview, setPreview] = useState<PreviewResult | null>(null)

  useEffect(() => {
    if (!link.trim()) {
      setPreview(null)
      return
    }
    let stale = false
    const timer = setTimeout(() => {
      void window.awg.previewLink(link).then((r) => !stale && setPreview(r))
    }, 250)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [link])

  return link.trim() ? preview : null
}

/**
 * The slots already taken on the master key a pasted link belongs to, asked as soon as the link parses. The
 * link itself says nothing about them; null until the server answers, and for good when it cannot.
 */
export function useKeyPeek(link: string, preview: PreviewResult | null): KeyBindings | null {
  const isMaster = preview?.ok === true && 'master' in preview
  const [peek, setPeek] = useState<{ link: string; bindings: KeyBindings | null } | null>(null)

  useEffect(() => {
    if (!isMaster) return
    let stale = false
    void window.awg.peekKey(link).then(
      (bindings) => !stale && setPeek({ link, bindings }),
      () => !stale && setPeek({ link, bindings: null })
    )
    return () => {
      stale = true
    }
  }, [link, isMaster])

  return isMaster && peek?.link === link ? peek.bindings : null
}
