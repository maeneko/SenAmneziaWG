import { useEffect, useState } from 'react'
import type { AppState } from '@shared/types'

export function useAppState(): AppState | null {
  const [state, setState] = useState<AppState | null>(null)

  useEffect(() => {
    // A pushed snapshot is always newer than the initial fetch, so it wins any race.
    let pushed = false
    const off = window.awg.onState((s) => {
      pushed = true
      setState(s)
    })
    void window.awg.getState().then((s) => {
      if (!pushed) setState(s)
    })
    return off
  }, [])

  return state
}
