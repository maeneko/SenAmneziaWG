import { Icon, type IconName } from './ui'

export type View = 'tunnels' | 'settings'

const ITEMS: { id: View; label: string; icon: IconName }[] = [
  { id: 'tunnels', label: 'Туннели', icon: 'tunnel' },
  { id: 'settings', label: 'Настройки', icon: 'settings' }
]

interface BottomNavProps {
  view: View
  onNavigate: (view: View) => void
  onQuit: () => void
}

/** MD3 navigation bar: icon in a pill indicator with the label under it. «Выход» is an action, never selected. */
export function BottomNav({ view, onNavigate, onQuit }: BottomNavProps): React.JSX.Element {
  return (
    <nav className="bottom-nav" aria-label="Разделы">
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
      <button type="button" className="bn-item bn-item-danger" onClick={onQuit}>
        <span className="bn-indicator">
          <Icon name="logout" size={24} />
        </span>
        <span className="bn-label">Выход</span>
      </button>
    </nav>
  )
}
