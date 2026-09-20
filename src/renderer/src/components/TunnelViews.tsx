import { useRef } from 'react'
import type { Tunnel, TunnelState } from '@shared/types'
import type { UiSettings } from '@shared/uiSettings'
import { endpointHost, formatBytes, formatUptime } from '../lib/format'
import { Icon, IconButton, VersionTag } from './ui'

export interface TunnelActions {
  connect: (id: string) => void
  disconnect: (id: string) => void
  remove: (tunnel: Tunnel) => void
}

export interface RowModel {
  tunnel: Tunnel
  state: TunnelState
  /** This is the server shown in the card above. */
  current: boolean
}

const isOn = (s: TunnelState): boolean => s.status === 'up' || s.status === 'connecting'

/** Big ring button with the state spelled out; the ring spins while the tunnel comes up or goes down. */
export function ConnectionHero({ tunnel, state, busy, switching, actions }: {
  tunnel: Tunnel
  state: TunnelState
  busy: boolean
  switching: boolean
  actions: TunnelActions
}): React.JSX.Element {
  const on = isOn(state)
  const stopping = busy && state.status === 'up'
  const spinning = state.status === 'connecting' || stopping
  const text = stopping
    ? 'Отключение…'
    : state.status === 'connecting'
      ? switching ? 'Переключение…' : 'Подключение…'
      : on ? 'Подключено' : 'Подключиться'
  return (
    <section className="hero" aria-label="Подключение">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={on ? `Отключить ${tunnel.name}` : `Подключить ${tunnel.name}`}
        aria-busy={spinning || undefined}
        title={on ? 'Нажмите, чтобы отключить' : undefined}
        disabled={busy}
        className={`power${spinning ? ' power-spin' : ''}${state.status === 'up' ? ' power-up' : ''}`}
        onClick={() => (on ? actions.disconnect(tunnel.id) : actions.connect(tunnel.id))}
      >
        <span className="power-text" aria-hidden="true">
          {text}
        </span>
      </button>
      <span className="visually-hidden" role="status">
        {text}
      </span>

      {state.error && (
        <p className="server-error" role="alert">
          {state.error}
        </p>
      )}
    </section>
  )
}

/** Data used and connection age, in the form chosen in Настройки. */
function usageItems(state: TunnelState, ui: UiSettings): React.JSX.Element[] | null {
  const stats = state.status === 'up' ? state.stats : undefined
  if (!stats || (ui.traffic === 'hidden' && !state.since)) return null
  const items: React.JSX.Element[] = []
  if (ui.traffic === 'total') {
    items.push(
      <span key="total" title="Скачано и отправлено с момента подключения">
        потрачено <span className="mono">{formatBytes(stats.rxBytes + stats.txBytes, ui.units)}</span>
      </span>
    )
  }
  if (ui.traffic === 'split') {
    items.push(
      <span key="rx" className="mono" title="Скачано">↓ {formatBytes(stats.rxBytes, ui.units)}</span>,
      <span key="tx" className="mono" title="Отправлено">↑ {formatBytes(stats.txBytes, ui.units)}</span>
    )
  }
  if (state.since) items.push(<span key="since">подключено {formatUptime(state.since, Date.now())}</span>)
  return items
}

/**
 * The line above the server bar. Its slot is always there and opens with the connection: the
 * height grows (nothing jumps), then the items rise in one after another. On disconnect the last
 * values stay visible while the slot closes.
 */
export function UsageLine({ state, ui, hidden = false }: {
  state: TunnelState
  ui: UiSettings
  /**
   * Faded out while the server list is open. Only faded, never collapsed: a height change here
   * would move the server bar and, with it, the sheet sliding up above it.
   */
  hidden?: boolean
}): React.JSX.Element {
  const items = usageItems(state, ui)
  const open = items !== null
  const last = useRef<React.JSX.Element[]>([])
  const wasOpen = useRef(false)
  const run = useRef(0)
  // A new connection remounts the items, so their entrance animation plays again.
  if (open && !wasOpen.current) run.current++
  wasOpen.current = open
  if (items) last.current = items

  return (
    <div
      className={`usage-slot${open ? ' usage-open' : ''}${hidden ? ' usage-faded' : ''}`}
      aria-hidden={!open || hidden || undefined}
    >
      <div className="usage-inner">
        <p key={run.current} className="usage-line">
          {last.current}
        </p>
      </div>
    </div>
  )
}

/** Current server above the navigation bar; opens and closes the server list. */
export function ServerBar({ tunnel, expanded, onToggle, usage }: {
  tunnel: Tunnel
  expanded: boolean
  onToggle: () => void
  /** Shown just above the bar, on the left. */
  usage?: React.ReactNode
}): React.JSX.Element {
  // The area spans the full window width so the sheet's dimming can continue under the bar
  // (see .server-bar-area::before) instead of ending in a visible seam above it.
  return (
    <div className={`server-bar-area${expanded ? ' server-bar-dim' : ''}`}>
      <div className="server-bar-wrap">
        {usage}
        <button type="button" className="server-bar sl" aria-haspopup="dialog" aria-expanded={expanded} onClick={onToggle}>
          <span className="server-bar-text">
            <span className="server-name">{tunnel.name}</span>
            <span className="row-sub">
              <span className="mono">{endpointHost(tunnel.endpoint)}</span>
              <span aria-hidden="true">·</span>
              <VersionTag awg={tunnel.awg} />
            </span>
          </span>
          <span className="visually-hidden">— выбрать сервер</span>
          <Icon name="chevron" size={22} />
        </button>
      </div>
    </div>
  )
}

/** Small pill, used twice: in the sheet's corner and after the last server. */
export function AddServerButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button type="button" className="add-server sl" onClick={onClick}>
      <Icon name="plus" size={18} />
      <span>Добавить сервер</span>
    </button>
  )
}

/**
 * Servers to pick from. With nothing running a row only selects the server for the power button;
 * with a tunnel running it switches to that server. Rows are inert while an operation is in flight.
 */
export function TunnelList({ rows, selectable, onSelect, onAdd, actions }: {
  rows: RowModel[]
  selectable: boolean
  onSelect: (id: string) => void
  /** Last row of the list, so a new server can be added from where servers are looked at. */
  onAdd?: () => void
  actions: TunnelActions
}): React.JSX.Element {
  return (
    <ul className="tunnel-list" aria-label="Серверы">
      {rows.map(({ tunnel, state, current }) => (
        <li key={tunnel.id} className={`tunnel-row${current ? ' tunnel-row-current' : ''}`}>
          <button
            type="button"
            className="tunnel-pick sl"
            aria-current={current ? 'true' : undefined}
            aria-disabled={!selectable && !current ? true : undefined}
            onClick={() => selectable && onSelect(tunnel.id)}
          >
            <span className="tunnel-name" title={tunnel.name}>
              {tunnel.name}
            </span>
            <span className="row-sub">
              <span className="mono">{endpointHost(tunnel.endpoint)}</span>
              <span aria-hidden="true">·</span>
              <VersionTag awg={tunnel.awg} />
            </span>
          </button>
          <IconButton
            className="row-delete"
            icon="trash"
            tone="danger"
            label={`Удалить ${tunnel.name}`}
            title={isOn(state) ? 'Сначала отключите' : `Удалить ${tunnel.name}`}
            disabled={isOn(state)}
            onClick={() => actions.remove(tunnel)}
          />
        </li>
      ))}
      {onAdd && (
        <li className="tunnel-add-row">
          <AddServerButton onClick={onAdd} />
        </li>
      )}
    </ul>
  )
}
