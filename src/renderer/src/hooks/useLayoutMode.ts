import { useEffect, useState } from 'react'

export type LayoutMode = 'wide' | 'narrow'

/**
 * design.md Part III (sidebar + table) from 960px, Part IV (drawer + cards) below. The 7-column table
 * needs ~660px beside the 240px sidebar before names and endpoints stop being truncated to nothing.
 */
const QUERY = '(max-width: 959px)'

export function useLayoutMode(): LayoutMode {
  const [narrow, setNarrow] = useState(() => window.matchMedia(QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia(QUERY)
    const onChange = (e: MediaQueryListEvent): void => setNarrow(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return narrow ? 'narrow' : 'wide'
}
