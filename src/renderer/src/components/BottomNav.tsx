import { useEffect, useState } from 'react'
import { Icon, type IconName } from './ui'

export type View = 'tunnels' | 'key' | 'profile' | 'settings'

const ITEMS: { id: View; label: string; icon: IconName }[] = [
  { id: 'tunnels', label: 'Туннели', icon: 'tunnel' },
  { id: 'key', label: 'Ключ', icon: 'key' },
  { id: 'profile', label: 'Профиль', icon: 'user' },
  { id: 'settings', label: 'Настройки', icon: 'settings' }
]

interface BottomNavProps {
  view: View
  onNavigate: (view: View) => void
  /** «Ключ» is there only while a master key is: nothing to show without one. */
  hasKey: boolean
  /** «Профиль» is there only while a master key names an MA7 login. */
  hasProfile: boolean
  /** Out of reach while something covers the whole window (the removal screen). */
  inert?: boolean
}

/** Whether an item that comes and goes was already there when the window opened: then it is simply there. */
function usePresent(shown: boolean): boolean {
  const [present, setPresent] = useState(shown)
  useEffect(() => {
    if (!shown) setPresent(false)
  }, [shown])
  return present
}

/**
 * MD3 navigation bar: icon in a pill indicator with the label under it. There is no «Выход»: closing the
 * window quits, and the tunnel and the Windows service go down with the process however it ends.
 */
export function BottomNav({ view, onNavigate, hasKey, hasProfile, inert }: BottomNavProps): React.JSX.Element {
  // «Ключ» and «Профиль» grow in when the master key appears; one that was already there when the window
  // opened, or when the page was reloaded, is simply there.
  const keyPresent = usePresent(hasKey)
  const profilePresent = usePresent(hasProfile)
  const shown = (id: View): boolean => (id === 'key' ? hasKey : id === 'profile' ? hasProfile : true)
  const growing = (id: View): boolean => (id === 'key' && !keyPresent) || (id === 'profile' && !profilePresent)

  return (
    <nav className="bottom-nav" aria-label="Разделы" inert={inert}>
      {ITEMS.filter((item) => shown(item.id)).map((item) => (
        <button
          key={item.id}
          type="button"
          className={`bn-item${growing(item.id) ? ' bn-item-in' : ''}`}
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
