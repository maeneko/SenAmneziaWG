import { useEffect, useState } from 'react'

export type LayoutMode = 'wide' | 'narrow'

/**
 * design.md Part III §1: one column either way; below 960px it is capped at 640px with 16px gutters,
 * from 960px at 1100px with 32px ones, and «Добавить сервер» in the header shows its label.
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
