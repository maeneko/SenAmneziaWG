import logo from '../../assets/logo.png'

/** App mark. Decorative: the wordmark or heading next to it names the app. */
export function Logo({ className = '' }: { className?: string }): React.JSX.Element {
  return <img src={logo} alt="" aria-hidden="true" draggable={false} className={['logo', className].filter(Boolean).join(' ')} />
}
