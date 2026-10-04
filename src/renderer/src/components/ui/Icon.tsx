import type { SVGProps } from 'react'

const PATHS = {
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  paste: 'M9 5H7a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5v-12A1.5 1.5 0 0 0 17 5h-2M9 4h6v3H9z',
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
  settings: 'M4 7h9M17 7h3M15 5v4M4 17h3M11 17h9M9 15v4',
  user: 'M8.5 8a3.5 3.5 0 1 0 7 0 3.5 3.5 0 1 0-7 0M5 20a7 7 0 0 1 14 0',
  card: 'M5 5.5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2zM3 10h18M7 15h3',
  logout: 'M13 4.5H6.5a1.5 1.5 0 0 0-1.5 1.5v12a1.5 1.5 0 0 0 1.5 1.5H13M10 12h10M16.5 8.5L20 12l-3.5 3.5',
  ticket: 'M4 6.5h16v3.5a2 2 0 0 0 0 4v3.5H4V14a2 2 0 0 0 0-4zM14.5 6.5v2M14.5 11v2M14.5 15.5v2',
  refresh: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 7.75v.5',
  alert: 'M10.3 4.9a2 2 0 0 1 3.4 0l7 12.1a2 2 0 0 1-1.7 3H5a2 2 0 0 1-1.7-3zM12 9.5v4M12 16.75v.5'
} as const

/** Brand marks are filled shapes drawn on their own grid, not 24px strokes. github: Octicons mark-github-16 (MIT). */
const GLYPHS = {
  github: {
    viewBox: '0 0 16 16',
    d: 'M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656'
  }
} as const

export type IconName = keyof typeof PATHS | keyof typeof GLYPHS

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName
  size?: number
}

/** Decorative by default (aria-hidden); the button that owns the icon supplies the accessible name. */
export function Icon({ name, size = 20, ...rest }: IconProps): React.JSX.Element {
  if (name in GLYPHS) {
    const glyph = GLYPHS[name as keyof typeof GLYPHS]
    return (
      <svg width={size} height={size} viewBox={glyph.viewBox} fill="currentColor" aria-hidden="true" focusable="false" {...rest}>
        <path d={glyph.d} />
      </svg>
    )
  }
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
      <path d={PATHS[name as keyof typeof PATHS]} />
    </svg>
  )
}
