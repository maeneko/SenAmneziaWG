import type { ComponentPropsWithRef, ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

export type ButtonVariant = 'filled' | 'tonal' | 'danger' | 'text'

interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant
  icon?: IconName
  block?: boolean
  children: ReactNode
}

/** Filled = main action, tonal = secondary, danger = outline only, text = no background. */
export function Button({
  variant = 'filled',
  icon,
  block,
  className = '',
  children,
  type = 'button',
  ...rest
}: ButtonProps): React.JSX.Element {
  const cls = ['btn', `btn-${variant}`, 'sl', block ? 'btn-block' : '', className].filter(Boolean).join(' ')
  return (
    <button type={type} className={cls} {...rest}>
      {icon && <Icon name={icon} />}
      <span>{children}</span>
    </button>
  )
}

interface IconButtonProps extends ComponentPropsWithRef<'button'> {
  icon: IconName
  /** Required: icon-only buttons have no visible label. */
  label: string
  tone?: 'default' | 'accent' | 'danger'
}

export function IconButton({ icon, label, tone = 'default', className = '', type = 'button', ...rest }: IconButtonProps): React.JSX.Element {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={['icon-btn', `icon-btn-${tone}`, 'sl', className].filter(Boolean).join(' ')}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  )
}
