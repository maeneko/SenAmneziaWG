import { useEffect, useRef, useState } from 'react'
import type { KeyBindings, PreviewResult } from '@shared/types'

/** Typing is let to pause before the link is read, so a half-typed key is not explained as a bad one. */
const TYPING_MS = 250

/**
 * The link once it has settled: at once when it arrived whole (pasted, or cleared), after a pause while it is
 * being typed one character at a time.
 */
function useSettledLink(link: string): string {
  const [settled, setSettled] = useState(link)
  const last = useRef(link)

  useEffect(() => {
    const typed = Math.abs(link.length - last.current.length) <= 1
    last.current = link
    if (!typed) {
      setSettled(link)
      return
    }
    const timer = setTimeout(() => setSettled(link), TYPING_MS)
    return () => clearTimeout(timer)
  }, [link])

  return settled
}

const looksMaster = (link: string): boolean => /^sen:\/\//i.test(link.trim())

/** Parses a vpn:// or sen:// link as it is typed or pasted, so a bad link is explained before anything is pressed. */
export function useLinkPreview(link: string): PreviewResult | null {
  const settled = useSettledLink(link)
  const [preview, setPreview] = useState<PreviewResult | null>(null)

  useEffect(() => {
    if (!settled.trim()) {
      setPreview(null)
      return
    }
    let stale = false
    void window.awg.previewLink(settled).then((r) => !stale && setPreview(r))
    return () => {
      stale = true
    }
  }, [settled])

  return link.trim() ? preview : null
}

/**
 * The slots already taken on the master key a pasted link belongs to. Asked the moment the link settles,
 * alongside its parsing rather than after it, so the number is there almost as soon as the server table.
 * `undefined` while the server is being asked; null when it cannot say (or the link is not a master key).
 */
export function useKeyPeek(link: string, preview: PreviewResult | null): KeyBindings | null | undefined {
  const settled = useSettledLink(link)
  const [peek, setPeek] = useState<{ link: string; bindings: KeyBindings | null } | null>(null)

  useEffect(() => {
    if (!looksMaster(settled)) return
    let stale = false
    // A link that does not parse is answered with null by the main process, without a request.
    void window.awg.peekKey(settled).then(
      (bindings) => !stale && setPeek({ link: settled, bindings }),
      () => !stale && setPeek({ link: settled, bindings: null })
    )
    return () => {
      stale = true
    }
  }, [settled])

  if (!(preview?.ok === true && 'master' in preview)) return null
  return peek?.link === link ? peek.bindings : undefined
}
