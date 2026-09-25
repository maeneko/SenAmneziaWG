import { useEffect, useState } from 'react'
import { Icon, type IconName } from './ui'

export type View = 'tunnels' | 'key' | 'settings'

const ITEMS: { id: View; label: string; icon: IconName }[] = [
  { id: 'tunnels', label: 'Туннели', icon: 'tunnel' },
  { id: 'key', label: 'Ключ', icon: 'key' },
  { id: 'settings', label: 'Настройки', icon: 'settings' }
]

interface BottomNavProps {
  view: View
  onNavigate: (view: View) => void
  /** «Ключ» is there only while a master key is: nothing to show without one. */
  hasKey: boolean
  /** Out of reach while something covers the whole window (the removal screen). */
  inert?: boolean
}

/**
 * MD3 navigation bar: icon in a pill indicator with the label under it. There is no «Выход»: closing the
 * window quits, and the tunnel and the Windows service go down with the process however it ends.
 */
export function BottomNav({ view, onNavigate, hasKey, inert }: BottomNavProps): React.JSX.Element {
  // «Ключ» grows in when the master key appears; a key that was already there when the window opened, or
  // when the page was reloaded, is simply there.
  const [present, setPresent] = useState(hasKey)
  useEffect(() => {
    if (!hasKey) setPresent(false)
  }, [hasKey])

  return (
    <nav className="bottom-nav" aria-label="Разделы" inert={inert}>
      {ITEMS.filter((item) => item.id !== 'key' || hasKey).map((item) => (
        <button
          key={item.id}
          type="button"
          className={`bn-item${item.id === 'key' && !present ? ' bn-item-in' : ''}`}
          aria-current={view === item.id ? 'page' : undefined}
          onClick={() => onNavigate(item.id)}
        >
          <span className="bn-indicator">
            <Icon name={item.icon} size={24} />
          </span>
          <span className="bn-label">{item.label}</span>
        </button>
      ))}
    </nav>
  )
}
