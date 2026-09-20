import { useCallback, useEffect, useState } from 'react'
import { UI_DEFAULTS, type UiSettings } from '@shared/uiSettings'

/** Display preferences from settings.json; a change shows at once and is then confirmed by main. */
export function useUiSettings(): [UiSettings, (patch: Partial<UiSettings>) => void] {
  const [settings, setSettings] = useState<UiSettings>(UI_DEFAULTS)

  useEffect(() => {
    void window.awg.getUiSettings().then(setSettings)
  }, [])

  const update = useCallback((patch: Partial<UiSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }))
    void window.awg.setUiSettings(patch).then(setSettings)
  }, [])

  return [settings, update]
}
