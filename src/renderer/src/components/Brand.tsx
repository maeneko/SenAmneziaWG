import { useState } from 'react'
import type { View } from './BottomNav'

/** What the header says next to the logo: the application on «Туннели», the section everywhere else. */
function Title({ view }: { view: View }): React.JSX.Element {
  if (view === 'settings') return <span className="brand-name">Настройки</span>
  return (
    <>
      <span className="brand-name">AmnesiaWG</span>
      <span className="brand-version">v{__APP_VERSION__}</span>
    </>
  )
}

/**
 * The header title. On a change of section the old one leaves upwards and the new one rises in its
 * place; the first render just stands there, so opening the app does not play a swap nobody asked for.
 */
export function Brand({ view }: { view: View }): React.JSX.Element {
  const [swap, setSwap] = useState({ view, prev: null as View | null, n: 0 })
  if (swap.view !== view) setSwap({ view, prev: swap.view, n: swap.n + 1 })

  return (
    <h1 className="brand">
      {swap.prev && (
        <span key={swap.n - 1} className="brand-title brand-out" aria-hidden="true">
          <Title view={swap.prev} />
        </span>
      )}
      <span key={swap.n} className={`brand-title${swap.n > 0 ? ' brand-in' : ''}`}>
        <Title view={swap.view} />
      </span>
    </h1>
  )
}
