import { useEffect, useState } from 'react'
import type { PywalPalette } from '@shared/types'
import { applyPywal } from '../lib/pywalTheme'

const POLL_MS = 3000

/**
 * While `enabled`, the interface wears pywal's palette and follows it: a new wallpaper rewrites colors.json,
 * which is read again every few seconds. Returns the palette in use, null when off or when there is none.
 */
export function usePywal(enabled: boolean): PywalPalette | null {
  const [palette, setPalette] = useState<PywalPalette | null>(null)

  useEffect(() => {
    if (!enabled) {
      setPalette(null)
      return
    }
    let alive = true
    const read = (): void => {
      void window.awg.getPywal().then((next) => {
        if (!alive) return
        setPalette((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
      })
    }
    read()
    const timer = setInterval(read, POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [enabled])

  useEffect(() => {
    applyPywal(palette)
    return () => applyPywal(null)
  }, [palette])

  return palette
}
