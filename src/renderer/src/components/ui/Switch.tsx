import type { InputHTMLAttributes } from 'react'

type SwitchProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> & {
  checked: boolean
  onChange: (checked: boolean) => void
}

/**
 * On/off for a setting that takes effect by itself, as opposed to a choice among several — those stay
 * radio buttons. The checkbox is still the real control, only made invisible: it keeps the keyboard,
 * the focus ring and the label's click for free, and the track and knob are painted over it.
 */
export function Switch({ checked, onChange, className = '', ...rest }: SwitchProps): React.JSX.Element {
  return (
    <span className={['switch', className].filter(Boolean).join(' ')}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} {...rest} />
      <span className="switch-track" aria-hidden="true">
        <span className="switch-knob" />
      </span>
    </span>
  )
}
