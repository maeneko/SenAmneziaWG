import type { SVGProps } from 'react'

const PATHS = {
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  trash: 'M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10 11v5M14 11v5',
  power: 'M12 3v8M7.5 6.5a7 7 0 1 0 9 0',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9S14.5 18.5 12 21M12 3C9.5 5.5 8.5 8.5 8.5 12s1 6.5 3.5 9',
  down: 'M12 5v14M6 13l6 6 6-6',
  up: 'M12 19V5M6 11l6-6 6 6',
  shield: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z',
  tunnel: 'M4 18V11a8 8 0 0 1 16 0v7M9 18v-6a3 3 0 0 1 6 0v6',
  logs: 'M5 6h14M5 10.5h14M5 15h9M5 19.5h6',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  chevron: 'M6 15l6-6 6 6',
  pulse: 'M3 12h3.5l2.5-6.5 4 13 2.5-6.5H21',
  key: 'M4.5 15.5a3.5 3.5 0 1 0 7 0 3.5 3.5 0 1 0-7 0M10.5 13l8.5-8.5M16 7.5l2.5 2.5',
  settings: 'M4 7h9M17 7h3M15 5v4M4 17h3M11 17h9M9 15v4'
} as const

export type IconName = keyof typeof PATHS

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName
  size?: number
}

/** Decorative by default (aria-hidden); the button that owns the icon supplies the accessible name. */
export function Icon({ name, size = 20, ...rest }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
