import { useCallback, useEffect, useState } from 'react'
import { UI_DEFAULTS, type UiSettings } from '@shared/uiSettings'

/** Display preferences from settings.json; a change shows at once and is then confirmed by main. */
export function useUiSettings(): [UiSettings, (patch: Partial<UiSettings>) => void, boolean] {
  const [settings, setSettings] = useState<UiSettings>(UI_DEFAULTS)
  // False until the file has been read: a question that must be asked once must not flash up before its answer is known.
  const [ready, setReady] = useState(false)

  useEffect(() => {
    void window.awg.getUiSettings().then((s) => {
      setSettings(s)
      setReady(true)
    })
  }, [])

  const update = useCallback((patch: Partial<UiSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }))
    void window.awg.setUiSettings(patch).then(setSettings)
  }, [])

  return [settings, update, ready]
}
