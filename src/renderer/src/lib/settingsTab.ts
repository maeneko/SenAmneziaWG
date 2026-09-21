export type SettingsTab = 'interface' | 'network' | 'app' | 'diagnostics'

const TAB_KEY = 'awg:settingsTab'
const TABS: SettingsTab[] = ['interface', 'network', 'app', 'diagnostics']

/** Which settings tab to open. Falls back to the first one whenever the stored value is unusable. */
export function readSettingsTab(): SettingsTab {
  try {
    const saved = localStorage.getItem(TAB_KEY)
    // «logs» is what this tab was called before it became «Диагностика».
    if (saved === 'logs') return 'diagnostics'
    // «Об SenAWG» was a tab of its own; it is the last block of «Приложение» now.
    if (saved === 'about') return 'app'
    return TABS.find((t) => t === saved) ?? 'interface'
  } catch {
    return 'interface'
  }
}

export function writeSettingsTab(tab: SettingsTab): void {
  try {
    localStorage.setItem(TAB_KEY, tab)
  } catch {
    /* per-viewer convenience only */
  }
}
