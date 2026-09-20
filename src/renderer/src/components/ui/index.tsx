import type { InputHTMLAttributes } from 'react'
import type { AwgParams } from '@shared/types'
import { AWG_VERSION_LABEL, detectAwgVersion } from '@shared/awgVersion'

export { Button, IconButton } from './Button'
export { Icon, type IconName } from './Icon'
export { Logo } from './Logo'
export { Switch } from './Switch'

/** Protocol generation of a config, inferred from its obfuscation parameters. Plain muted text. */
export function VersionTag({ awg }: { awg: AwgParams }): React.JSX.Element {
  return (
    <span className="version-tag" title="Версия протокола AmneziaWG">
      {AWG_VERSION_LABEL[detectAwgVersion(awg)]}
    </span>
  )
}

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string
  mono?: boolean
}

export function TextField({ label, mono, className = '', id, ...rest }: TextFieldProps): React.JSX.Element {
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      <input id={id} className={['input', mono ? 'mono' : '', className].filter(Boolean).join(' ')} {...rest} />
    </label>
  )
}
