import { useEffect, useState } from 'react'
import type { ImportResult } from '@shared/types'

/** Parses a vpn:// link as it is typed (debounced), so a bad link is explained before anything is pressed. */
export function useLinkPreview(link: string): ImportResult | null {
  const [preview, setPreview] = useState<ImportResult | null>(null)

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
