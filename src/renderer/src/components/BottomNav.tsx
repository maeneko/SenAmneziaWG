import { Icon, type IconName } from './ui'

export type View = 'tunnels' | 'settings'

const ITEMS: { id: View; label: string; icon: IconName }[] = [
  { id: 'tunnels', label: 'Туннели', icon: 'tunnel' },
  { id: 'settings', label: 'Настройки', icon: 'settings' }
]

interface BottomNavProps {
  view: View
  onNavigate: (view: View) => void
  /** Out of reach while something covers the whole window (the removal screen). */
  inert?: boolean
}

/**
 * MD3 navigation bar: icon in a pill indicator with the label under it. There is no «Выход»: closing the
 * window quits, and the tunnel and the Windows service go down with the process however it ends.
 */
export function BottomNav({ view, onNavigate, inert }: BottomNavProps): React.JSX.Element {
  return (
    <nav className="bottom-nav" aria-label="Разделы" inert={inert}>
      {ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          className="bn-item"
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
